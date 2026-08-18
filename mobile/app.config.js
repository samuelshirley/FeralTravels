/**
 * Expo config as JS (not app.json) so build-time env can reach the native
 * layer — specifically the Google Maps iOS SDK key, which react-native-maps
 * needs baked into the binary, and the reversed Google OAuth client id, which
 * has to be a registered URL scheme for the native sign-in redirect to come
 * back to the app.
 *
 * Everything degrades: with no Google keys the map falls back to Apple Maps
 * and the Google sign-in button hides itself rather than dead-ending.
 */
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || null;
const APPLE_SIGNIN = process.env.EXPO_PUBLIC_ENABLE_APPLE_SIGNIN === '1';

// Google's iOS OAuth redirect scheme is the client id with its dot-segments
// reversed: 123-abc.apps.googleusercontent.com -> com.googleusercontent.apps.123-abc
const reversedClientId = GOOGLE_IOS_CLIENT_ID
  ? GOOGLE_IOS_CLIENT_ID.split('.').reverse().join('.')
  : null;

module.exports = {
  expo: {
    name: 'Feral Travels',
    slug: 'feral-travels',
    version: '1.0.0',
    scheme: 'feraltravels',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: {
      bundleIdentifier: 'com.feraltravels.app',
      supportsTablet: false,
      // Guideline 4.8: offering Google sign-in obliges us to offer Sign in
      // with Apple as well. But the entitlement this flag adds requires a
      // provisioning profile, which turns every local build into a
      // code-signing problem — and Apple sign-in cannot be exercised on a
      // simulator without a team anyway. Opt in when building for a device or
      // TestFlight: EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1 npx expo prebuild --clean
      // AppleAuthentication.isAvailableAsync() returns false without it, so
      // the button hides itself rather than dead-ending.
      ...(APPLE_SIGNIN ? { usesAppleSignIn: true } : {}),
      config: {
        // Only set when present — an empty string makes the Google map render
        // as a blank grey rectangle, which is worse than falling back to Apple.
        ...(process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
          ? { googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY }
          : {}),
      },
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'Feral Travels uses your location to anchor your trip progress and plan fuel stops along your route.',
        NSPhotoLibraryUsageDescription:
          'Feral Travels lets you attach photos to your messages with Penny so she can see what you are looking at.',
        ...(reversedClientId
          ? { CFBundleURLTypes: [{ CFBundleURLSchemes: [reversedClientId] }] }
          : {}),
      },
    },
    android: { package: 'com.feraltravels.app' },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-web-browser',
      ...(APPLE_SIGNIN ? ['expo-apple-authentication'] : []),
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission:
            'Feral Travels uses your location to anchor your trip progress and plan fuel stops along your route.',
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission:
            'Feral Travels lets you attach photos to your messages with Penny so she can see what you are looking at.',
        },
      ],
    ],
    experiments: { typedRoutes: true },
  },
};
