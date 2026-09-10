/**
 * aezeed: lnd's 24-word cipher seed scheme. Public API of this module.
 *
 * Typical use from the UI:
 *   const words = normaliseMnemonic(userInput);
 *   const report = validateWords(words);            // per-word validity + typo suggestions
 *   const seed = await decipherMnemonic(words, passphrase); // CipherSeed; scrypt runs async
 *   birthdayToDate(seed.birthdayDays)
 */

export { aezDecrypt, aezEncrypt } from "./aez";
export {
  AezeedError,
  BITCOIN_GENESIS_UNIX_SECONDS,
  BITS_PER_WORD,
  ChecksumError,
  CIPHER_SEED_VERSION,
  CIPHER_TEXT_EXPANSION,
  DECIPHERED_CIPHER_SEED_SIZE,
  ENCIPHERED_CIPHER_SEED_SIZE,
  ENTROPY_SIZE,
  InvalidPassphraseError,
  NUM_MNEMONIC_WORDS,
  PRODUCTION_SCRYPT_PARAMS,
  SALT_SIZE,
  UnknownWordError,
  WordCountError,
  WrongVersionError,
  birthdayToDate,
  bytesToMnemonic,
  checkMnemonicWords,
  crc32c,
  dateToBirthday,
  decipherBytes,
  decipherBytesSync,
  decipherMnemonic,
  decipherMnemonicSync,
  encipherBytes,
  encipherBytesSync,
  mnemonicFromCipherSeed,
  mnemonicFromCipherSeedSync,
  mnemonicToBytes,
  normaliseMnemonic,
  suggestWords,
  validateWords,
} from "./cipherseed";
export type { DecipherOptions, Passphrase, ScryptParams, WordValidation } from "./cipherseed";
export { WORDLIST, WORD_INDEX } from "./wordlist";
export type { CipherSeed } from "../types";
