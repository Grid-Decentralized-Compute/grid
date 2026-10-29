import { useEffect, useState } from "react";
import { normalizeSshKey } from "@grid/shared";

const STORAGE_KEY = "grid-ssh-key";

/**
 * The renter's SSH public key, remembered in this browser. A public key is not a secret; the
 * private half never leaves the renter's own machine and Grid never sees it.
 */
export function useSshKey(): [text: string, setText: (v: string) => void, key: string | null] {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const key = normalizeSshKey(text);
  useEffect(() => {
    try {
      if (key) localStorage.setItem(STORAGE_KEY, key);
    } catch {
      // storage blocked: the key just has to be pasted again next time
    }
  }, [key]);
  return [text, setText, key];
}

/**
 * The fingerprint SSH prints for a key, "SHA256:<base64>", with its algorithm, e.g. "ED25519".
 * Shown so a renter can compare it with what their SSH client reports on first connect.
 */
export async function fingerprint(key: string): Promise<string> {
  const [type, blob] = key.split(" ");
  const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const b64 = btoa(String.fromCharCode(...digest)).replace(/=+$/, "");
  const alg = type === "ssh-ed25519" ? "ED25519" : type === "ssh-rsa" ? "RSA" : type.startsWith("ecdsa") ? "ECDSA" : type.toUpperCase();
  return `${alg} SHA256:${b64}`;
}

/** A fingerprint computed once per key string. */
export function useFingerprint(key: string | null): string | null {
  const [fp, setFp] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!key) setFp(null);
    else void fingerprint(key).then((f) => live && setFp(f), () => live && setFp(null));
    return () => {
      live = false;
    };
  }, [key]);
  return fp;
}
