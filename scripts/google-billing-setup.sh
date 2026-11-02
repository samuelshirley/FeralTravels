#!/usr/bin/env bash
#
# Wire the /admin "Google · month to date" tile to Google's own billing figures.
#
#   bash scripts/google-billing-setup.sh
#
# Idempotent: re-run it as many times as you like — every step checks before it
# creates. What it does, against the gcloud project you are pointed at (or the
# one you type when asked):
#
#   1. enables the BigQuery and BigQuery Data Transfer APIs (the export needs both)
#   2. creates the dataset `billing_export` (location: $BILLING_DATASET_LOCATION, default EU)
#   3. creates the service account `feral-admin-billing`, with exactly two grants:
#      READER on that one dataset, and BigQuery Job User on the project
#   4. creates a key for it, written to a 0600 file outside the repo
#   5. stops at the ONE step Google offers no API or CLI for — switching the
#      billing account's "Standard usage cost" export to BigQuery — and opens
#      the exact Console page for it
#   6. once the export table exists, runs the app's own read
#      (src/server/providerSpend/google.ts) with the new key, so a green run
#      here means the tile will work
#   7. sets GOOGLE_BILLING_SA_KEY_JSON and GOOGLE_BILLING_EXPORT_TABLE in Vercel
#      PRODUCTION if the Vercel CLI is installed and this checkout is linked;
#      otherwise prints where the two values are
#
# Needs: gcloud (signed in as someone who can administer the project and view
# the billing account), bq, python3, node/npx.
# Never touches the app's database.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$(pwd)"

DATASET="billing_export"
SA_NAME="feral-admin-billing"
LOCATION="${BILLING_DATASET_LOCATION:-EU}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

for bin in gcloud bq python3 npx; do
  command -v "$bin" >/dev/null || die "$bin is not installed."
done

# ── Project and billing account ─────────────────────────────────────────────
PROJECT="${GOOGLE_BILLING_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT" || "$PROJECT" == "(unset)" ]]; then
  read -r -p "GCP project to hold the billing export (the one with the Maps key): " PROJECT
fi
[[ -n "$PROJECT" ]] || die "No project."
say "Project: $PROJECT"

BILLING_NAME="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)')"
[[ -n "$BILLING_NAME" ]] || die "Project $PROJECT has no billing account linked."
BILLING_ID="${BILLING_NAME#billingAccounts/}"
TABLE_NAME="gcp_billing_export_v1_${BILLING_ID//-/_}"
FQN="${PROJECT}.${DATASET}.${TABLE_NAME}"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
say "Billing account: $BILLING_ID  →  export table will be $FQN"

# ── 1. APIs ─────────────────────────────────────────────────────────────────
say "1/7 Enabling BigQuery + BigQuery Data Transfer APIs"
gcloud services enable bigquery.googleapis.com bigquerydatatransfer.googleapis.com --project "$PROJECT"

# ── 2. Dataset ──────────────────────────────────────────────────────────────
say "2/7 Dataset ${PROJECT}:${DATASET} ($LOCATION)"
if bq --project_id "$PROJECT" show --format=none "${PROJECT}:${DATASET}" >/dev/null 2>&1; then
  echo "exists"
else
  bq --project_id "$PROJECT" --location "$LOCATION" mk --dataset \
    --description "Cloud Billing export, read by feraltravels /admin" "${PROJECT}:${DATASET}"
fi

# ── 3. Service account + grants ─────────────────────────────────────────────
say "3/7 Service account $SA_EMAIL"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then
  echo "exists"
else
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" \
    --display-name "Feral Travels admin — billing export reader"
fi
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/bigquery.jobUser --condition=None --quiet >/dev/null
echo "granted roles/bigquery.jobUser on $PROJECT"

# Dataset READER through the dataset's own ACL — scoped to this one dataset,
# not every dataset in the project as a project-level dataViewer would be.
ACL_JSON="$(mktemp)"
trap 'rm -f "$ACL_JSON"' EXIT
bq --project_id "$PROJECT" show --format=prettyjson "${PROJECT}:${DATASET}" > "$ACL_JSON"
CHANGED="$(python3 - "$ACL_JSON" "$SA_EMAIL" <<'PY'
import json, sys
path, sa = sys.argv[1], sys.argv[2]
d = json.load(open(path))
access = d.setdefault("access", [])
if any(a.get("userByEmail") == sa and a.get("role") == "READER" for a in access):
    print("no")
else:
    access.append({"role": "READER", "userByEmail": sa})
    json.dump({"access": access}, open(path, "w"))
    print("yes")
PY
)"
if [[ "$CHANGED" == "yes" ]]; then
  bq --project_id "$PROJECT" update --source "$ACL_JSON" "${PROJECT}:${DATASET}" >/dev/null
  echo "granted READER on ${DATASET}"
else
  echo "READER on ${DATASET} already granted"
fi

# ── 4. Key ──────────────────────────────────────────────────────────────────
KEY_DIR="${HOME}/.config/feraltravels"
KEY_FILE="${KEY_DIR}/google-billing-sa.json"
say "4/7 Service-account key → $KEY_FILE"
mkdir -p "$KEY_DIR" && chmod 700 "$KEY_DIR"
if [[ -s "$KEY_FILE" ]]; then
  echo "exists (delete it and re-run to rotate)"
else
  umask 077
  gcloud iam service-accounts keys create "$KEY_FILE" --iam-account "$SA_EMAIL" --project "$PROJECT" \
    || die "Key creation refused. If your org enforces iam.disableServiceAccountKeyCreation, lift it for $PROJECT or create the key in the Console, save it to $KEY_FILE, and re-run."
fi

# ── 5. The Console-only step ────────────────────────────────────────────────
EXPORT_URL="https://console.cloud.google.com/billing/${BILLING_ID}/export/bigquery?project=${PROJECT}"
table_exists() { bq --project_id "$PROJECT" show --format=none "$FQN" >/dev/null 2>&1; }
if table_exists; then
  say "5/7 Billing export table already exists"
else
  say "5/7 Turn on the export (Google has no CLI/API for this step)"
  cat <<EOF
On the page that opens: "Standard usage cost" → EDIT SETTINGS →
  Project: $PROJECT   Dataset: $DATASET   → SAVE
$EXPORT_URL
EOF
  (command -v open >/dev/null && open "$EXPORT_URL") || (command -v xdg-open >/dev/null && xdg-open "$EXPORT_URL") || true
  read -r -p "Press Enter once you have saved it… "
  echo "Waiting for Google to create $TABLE_NAME (checks every 60 s for 15 min)…"
  for _ in $(seq 1 15); do
    table_exists && break
    sleep 60
  done
fi

# ── 6. Verify with the app's own read ───────────────────────────────────────
if table_exists; then
  say "6/7 Reading month-to-date through src/server/providerSpend/google.ts"
  CHECK_DIR="$(mktemp -d)"
  # .cts + require: the repo is CommonJS, so an ESM named import of the .ts
  # module does not resolve (measured: "does not provide an export named").
  CHECK="${CHECK_DIR}/billing-check.cts"
  cat > "$CHECK" <<EOF
const { getGoogleSpend } = require('${REPO}/src/server/providerSpend/google.ts');
getGoogleSpend().then((r: { status: string }) => {
  console.log(JSON.stringify(r, null, 2));
  if (r.status !== 'ok') process.exit(1);
});
EOF
  GOOGLE_BILLING_SA_KEY_JSON="$(cat "$KEY_FILE")" GOOGLE_BILLING_EXPORT_TABLE="$FQN" npx --yes tsx "$CHECK" \
    || { rm -rf "$CHECK_DIR"; die "The read failed — the message above is what the tile would show."; }
  rm -rf "$CHECK_DIR"
else
  say "6/7 Skipped: the export table does not exist yet"
  echo "Google creates it with the first rows, which can take a few hours. Re-run this script then."
fi

# ── 7. Vercel production env ────────────────────────────────────────────────
say "7/7 Vercel production env"
if command -v vercel >/dev/null && [[ -f .vercel/project.json ]]; then
  for pair in "GOOGLE_BILLING_EXPORT_TABLE=$FQN" "GOOGLE_BILLING_SA_KEY_JSON=@$KEY_FILE"; do
    name="${pair%%=*}"; value="${pair#*=}"
    [[ "$value" == @* ]] && value="$(cat "${value#@}")"
    vercel env rm "$name" production --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel env add "$name" production >/dev/null
    echo "set $name"
  done
  echo "Redeploy (or merge the next PR) for production to pick them up."
else
  cat <<EOF
The Vercel CLI is not installed or this checkout is not linked (vercel link), so set these
in Vercel → Project → Settings → Environment Variables → Production:
  GOOGLE_BILLING_EXPORT_TABLE = $FQN
  GOOGLE_BILLING_SA_KEY_JSON  = the contents of $KEY_FILE
EOF
fi
