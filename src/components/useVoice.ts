"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice I/O for the chat panel, built on the browser's native Web Speech APIs
 * rather than a cloud provider — no API key, no cost, no server round-trip,
 * works the moment the page loads. This is a deliberate MVP choice: a paid
 * provider (ElevenLabs, OpenAI TTS) would sound better, but the free path
 * needs nothing configured, which matches how the rest of this app treats
 * "does it actually work with zero setup" as the default to beat.
 *
 * Browser support varies: SpeechRecognition is solid in Chrome/Edge, partial
 * in Safari, and largely absent in Firefox as of this writing. SpeechSynthesis
 * (the output half) is broadly supported. Both are feature-detected — a
 * browser missing one gets that half disabled rather than a broken button.
 */

// The Web Speech API has no official TS lib types; this is the subset used here.
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Strips markdown syntax so read-aloud text sounds like speech, not source. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>-]{1,3}/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VoiceState {
  listenSupported: boolean;
  speakSupported: boolean;
  listening: boolean;
  speaking: boolean;
  /** Toggles microphone capture. Interim results stream through onTranscript. */
  startListening: () => void;
  stopListening: () => void;
  /** Reads text aloud (markdown is stripped automatically). */
  speak: (text: string) => void;
  stopSpeaking: () => void;
}

export function useVoice(onTranscript: (text: string, isFinal: boolean) => void): VoiceState {
  // Support is detected in an effect, not a useState initializer. This
  // component renders on the server first (Next.js still SSRs "use client"
  // components for their initial HTML), where `window` does not exist — a
  // useState initializer that checks for it would make the server's render
  // say "unsupported" while the browser's first render says "supported",
  // and React would flag that mismatch as a hydration error. Starting both
  // renders at `false` and flipping to the real value after mount keeps the
  // first paint identical on both sides; the controls appear a tick later.
  const [listenSupported, setListenSupported] = useState(false);
  const [speakSupported, setSpeakSupported] = useState(false);
  useEffect(() => {
    setListenSupported(getRecognitionCtor() !== null);
    setSpeakSupported("speechSynthesis" in window);
  }, []);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const startListening = useCallback(() => {
    if (!listenSupported || listening) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";

    recognition.onresult = (event) => {
      let transcript = "";
      let isFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        transcript += result[0].transcript;
        if (result.isFinal) isFinal = true;
      }
      onTranscriptRef.current(transcript, isFinal);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listenSupported, listening]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!speakSupported) return;
      const clean = stripMarkdownForSpeech(text);
      if (!clean) return;
      window.speechSynthesis.cancel(); // one reply speaks at a time
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    },
    [speakSupported],
  );

  const stopSpeaking = useCallback(() => {
    if (!speakSupported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [speakSupported]);

  // Stop everything if the panel unmounts mid-speech or mid-listen.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (speakSupported) window.speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { listenSupported, speakSupported, listening, speaking, startListening, stopListening, speak, stopSpeaking };
}
