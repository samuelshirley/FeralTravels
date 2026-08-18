# TripMap — native config required before it renders

`components/TripMap.tsx` uses `react-native-maps` (1.20.1). Unlike the rest of the
app it needs **native** setup — the JS alone will not put a map on screen.

## 1. It does NOT work in Expo Go

`react-native-maps` ships native code, so Expo Go (which only contains Expo's own
prebuilt modules) cannot render it. You need a **development build**:

```bash
npx expo prebuild            # generates ios/ and android/
npx expo run:ios             # or: eas build --profile development --platform ios
```

Then `npx expo start --dev-client` instead of the Expo Go client. In Expo Go the
map surface stays blank and the component falls into its "Map failed to load."
state after ~20s.

## 2. Google Maps iOS SDK key in `app.json`

The component asks for `PROVIDER_GOOGLE` whenever
`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` is set (see `lib/config.ts`), because the web
product is Google Maps and iOS otherwise defaults to Apple Maps. **Passing the
provider is not enough** — the Google Maps iOS SDK reads its key from the native
config:

```jsonc
// app.json
{
  "expo": {
    "ios": {
      "config": {
        "googleMapsApiKey": "AIza..."   // iOS SDK key (Maps SDK for iOS enabled)
      }
    },
    "android": {
      "config": {
        "googleMaps": { "apiKey": "AIza..." }  // Android SDK key
      }
    }
  }
}
```

Notes:

- These are **native SDK keys**, restricted per platform in Google Cloud
  (bundle ID for iOS, package name + SHA-1 for Android). They are not the same
  credential as the web's `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (a browser-restricted
  JS API key), and not the same as the server-side Places/Directions key.
- Required APIs: **Maps SDK for iOS** and **Maps SDK for Android**.
- Changing `app.json` requires a **rebuild** of the dev client — it is baked into
  the native project, not read at runtime.
- Android always renders Google Maps regardless of the `provider` prop; the
  provider constant only changes iOS.

## 3. Degradation when a key is missing

Nothing crashes. With `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` unset the component falls
back to the platform default provider — Apple Maps on iOS — and the routes,
markers and clustering all still work. What you lose is the warm cream basemap
(`customMapStyle` is Google-only). With the provider forced on but the native key
missing, iOS shows a blank grey surface: that is the case the 20s watchdog turns
into the visible "Map failed to load." message.

## 4. Environment variable

```bash
# .env / EAS secret — must be EXPO_PUBLIC_ prefixed to reach the client bundle
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...
```

This only decides whether the component *requests* Google as the provider. The
key that actually authenticates the SDK is the one in `app.json` above.
