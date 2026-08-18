import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Native mirror of src/lib/useKeyboardOpen.ts.
 *
 * The web has to infer the keyboard from VisualViewport shrinkage; RN tells us
 * outright. Same consumer contract: the trip workspace hides the bottom nav
 * while this is true so the chat composer isn't crowded off the screen.
 *
 * iOS emits `keyboardWillShow` ahead of the slide-in animation, so the nav is
 * already gone by the time the keyboard arrives — no visible reflow. Android
 * never emits the `Will` pair, so it falls back to `Did`.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () => setOpen(true));
    const hide = Keyboard.addListener(hideEvent, () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return open;
}
