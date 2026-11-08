export function verifyCanonicalMetadata(nodeBytes: Uint8Array, pythonBytes: Uint8Array): { sha256: string; bytes: number };
export function checkPackagedMetadata(): { passed: boolean; asset: string; sha256: string; bytes: number };
