/**
 * Spinner — Animated spinner with a label, shown during API calls.
 */

import React, { useState, useEffect } from "react";
import { Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

interface SpinnerProps {
  label: string;
}

const Spinner: React.FC<SpinnerProps> = ({ label }) => {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, FRAME_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  return (
    <Text>
      <Text color="cyan">{SPINNER_FRAMES[frameIndex]}</Text>
      <Text> {label}</Text>
    </Text>
  );
};

export default Spinner;
