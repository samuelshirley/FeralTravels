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

Bundle ID: `com.feraltravels.app` (permanent — set in `app.json`).
