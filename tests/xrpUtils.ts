import * as xrpl from 'xrpl';

/**
 * Creates an XRPL wallet from an Ethereum-format private key
 * @param ethPrivateKey - Ethereum private key (hex string with or without 0x prefix)
 * @returns XRPL wallet object with address, publicKey, privateKey, and seed
 * @throws Error if private key format is invalid
 */
export function createXRPLWalletFromEthKey(ethPrivateKey: string): xrpl.Wallet {
  // Remove 0x prefix if present and validate format
  const cleanPrivateKey = ethPrivateKey.startsWith('0x') 
    ? ethPrivateKey.slice(2) 
    : ethPrivateKey;

  if (!/^[0-9a-fA-F]{64}$/.test(cleanPrivateKey)) {
    throw new Error('Invalid private key format. Must be 64 hex characters.');
  }

  // Use the private key as entropy to generate XRPL wallet
  const entropy = Buffer.from(cleanPrivateKey, 'hex');

  return xrpl.Wallet.fromEntropy(entropy);
}