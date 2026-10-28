/** Crypto parameters and device-local key file names. */

export const DEVICE_KEY_FILE_NAME = "device.key";

export const PASSPHRASE_CACHE_FILE_NAME = "passphrase.enc";

export const DEVICE_KEY_BYTES = 32;

export const BLOB_VERSION = 0x01;

/** Same envelope, plaintext gzipped; an older build rejects it by version instead of failing in JSON.parse. */
export const BLOB_VERSION_GZIP = 0x02;

/**
 * Gzip-sealed like 0x02, its plaintext a length-prefixed JSON header and then a payload. The one blob that
 * `decryptBytes` refuses: it is file content only, never JSON, a key or a link.
 */
export const BLOB_VERSION_DESCRIBED = 0x03;

/** uint32 little-endian length of the header JSON, ahead of it in a described plaintext. */
export const DESCRIBED_HEADER_BYTES = 4;

/**
 * Below this gzip framing costs more than it saves and any build can read the document (a 20k-file manifest
 * gzips 3.4 MB to 1.0 MB).
 */
export const JSON_GZIP_MIN_BYTES = 16 * 1024;

/**
 * Compressed length is padded to this multiple before encryption: compress-then-encrypt leaks through length,
 * letting a chosen-string probe confirm a guess.
 */
export const GZIP_PAD_BYTES = 4 * 1024;

/** Larger inputs are compressed only when this much of their start shrinks below the ratio. */
export const GZIP_SAMPLE_BYTES = 64 * 1024;

export const GZIP_SAMPLE_MAX_RATIO = 0.9;

/** uint32 little-endian gzip length, ahead of the padding. */
export const GZIP_LENGTH_BYTES = 4;

export const IV_BYTES = 12;

export const KDF_ITERATIONS = 200_000;

/** Code points; length buys far more against offline guessing than iterations. */
export const MIN_PASSPHRASE_LENGTH = 12;

export const KDF_SALT_LABEL = "mdsync.v1.kdf";
