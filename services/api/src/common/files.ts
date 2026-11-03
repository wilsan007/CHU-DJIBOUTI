/** Signatures de fichiers acceptés : le type annoncé doit correspondre au contenu. */
export const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) =>
    b.length > 8 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "application/pdf": (b) => b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-",
};
