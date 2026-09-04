import { useEffect, useState } from "react";
import { AccessibilityInfo, Image, StyleSheet, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { theme } from "@/lib/theme";

/**
 * Native port of src/components/PennyPlanningVideo.tsx — the dog-fetch clip
 * Penny "sends" while she builds the first full trip plan.
 *
 * Renders ONLY the rounded, iMessage-style video bubble; the caption and the
 * surrounding message row are ChatPanel's. The clip lives in a real, persistent
 * Penny message (`planningMedia` on UIMessage), so it stays in the transcript
 * and keeps looping in place rather than vanishing when her reply streams in.
 *
 * The two assets are byte-for-byte copies of `public/penny-planning.{mp4,jpg}`
 * — bundled, not fetched from the API host, so the clip is there on a cold
 * launch with no network and never waits on a 2 MB download at exactly the
 * moment the user is being asked to wait for something else. Replace both
 * copies together when the clip changes.
 *
 * Mirrors the web's degradation rules:
 *   - Reduce Motion holds the poster still frame instead of a looping clip.
 *   - A player error renders NOTHING, so the caption stands alone rather than
 *     sitting above a broken media box.
 *   - Muted, and `mixWithOthers`: a silent dog video must never duck or pause
 *     the driver's music or navigation audio. `auto` would also leave other
 *     audio alone while muted, but that is a property of the current value of
 *     a flag, not of the clip; `mixWithOthers` is the rule stated outright.
 *   - Plays at natural 1x (playbackRate pinned to 1 — never sped up).
 */

const CLIP = require("../../assets/penny-planning.mp4");
const POSTER = require("../../assets/penny-planning.jpg");

// Web renders the bubble 200px wide with `height: auto`; the clip is 720×960,
// so pin the same 3:4 box here — RN has no intrinsic-size layout for video.
const WIDTH = 200;
const HEIGHT = Math.round((WIDTH * 960) / 720);

export default function PennyPlanningVideo() {
  const [mediaOk, setMediaOk] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  const player = useVideoPlayer(CLIP, (p) => {
    p.loop = true;
    p.muted = true;
    p.playbackRate = 1;
    p.audioMixingMode = "mixWithOthers";
    p.play();
  });

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReducedMotion(enabled);
      })
      .catch(() => {
        /* unknown → treat as motion allowed, same as the web default */
      });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  // A player that cannot decode or find the asset never gets a bubble.
  useEffect(() => {
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status === "error") setMediaOk(false);
    });
    return () => sub.remove();
  }, [player]);

  // Reduce Motion toggled while the bubble is on screen: stop the loop and let
  // the poster show; toggled back, resume. The hook's setup already started it.
  useEffect(() => {
    if (reducedMotion) player.pause();
    else player.play();
  }, [reducedMotion, player]);

  if (!mediaOk) return null;

  return (
    <View style={styles.bubble}>
      {reducedMotion ? (
        <Image
          source={POSTER}
          style={styles.media}
          resizeMode="cover"
          accessible={false}
          onError={() => setMediaOk(false)}
        />
      ) : (
        <>
          {/* Poster underneath so the first paint is the still frame, not a
              black box, while the player decodes its first frame on top. */}
          <Image source={POSTER} style={[styles.media, StyleSheet.absoluteFill]} resizeMode="cover" />
          <VideoView
            player={player}
            style={styles.media}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
            allowsFullscreen={false}
            accessible={false}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // .penny-planning-media-bubble: corners clip the clip, no card frame.
  bubble: {
    alignSelf: "flex-start",
    width: WIDTH,
    height: HEIGHT,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: theme.surface,
  },
  media: { width: WIDTH, height: HEIGHT },
});
