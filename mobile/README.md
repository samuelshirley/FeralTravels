# Feral Travels — mobile (Expo / React Native)

Native iOS (and later Android) client. Pure UI client of the existing
Next.js API — no backend code here. See `docs/design/ios-app-plan.md`
for the full plan.

## First-time setup (run on your Mac, not in a sandbox)

```bash
cd mobile
npm install
npx expo install --fix   # aligns native dep versions to the Expo SDK
npx expo-doctor          # sanity check
```

## Run it

```bash
# iOS simulator (needs Xcode installed)
EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo start --ios

# Physical iPhone via Expo Go: scan the QR, use your Mac's LAN IP
EXPO_PUBLIC_API_URL=http://192.168.x.x:3000 npx expo start
```

## TestFlight

```bash
npm install -g eas-cli   # once
eas login                # once (Expo account)
eas build --platform ios --profile production
eas submit --platform ios --latest
```

First `eas build` walks you through Apple credentials interactively
(Apple ID sign-in, it creates certs/profiles for you). The app record in
App Store Connect is created automatically on first `eas submit`.

Bundle ID: `com.feraltravels.ios`, set in `app.config.js`.

**Renamed from `com.feraltravels.app` on 2026-09-02**, when the app moved to a
new Apple developer account. The old id is permanently unusable: uploading a
TestFlight build binds a bundle id to the account that uploaded it, forever
(confirmed with Apple DTS). Nothing had shipped, so it was a pure rename.

**`mobile/eas.json` still carries one stale value: `ascAppId`.** It is the old
account's app record, and it now disagrees with `appleTeamId` (`TJX3F3832H`,
correct since 2026-09-02) — so `eas submit` fails rather than uploading to the
wrong place. It clears when the new record exists.

`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` needed no change at all: the Google iOS OAuth
client was edited in place to point at the new bundle id rather than replaced,
so the id is the same one. Do not delete that client — it is the live one. The
table in `docs/design/iap-setup.md` is the full list.

Android is deliberately still `com.feraltravels.app` — the binding is Apple's
and Play has never seen this id.
