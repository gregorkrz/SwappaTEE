const xrpl = require('xrpl');

/**
 * Refuels an XRPL wallet using testnet faucet if balance is low
 * @param {xrpl.Wallet} wallet - XRPL wallet to refuel
 * @param {xrpl.Client} [client] - XRPL client instance (optional, will create one if not provided)
 * @param {number} [minBalance=5] - Minimum balance in XRP to trigger refuel (default: 5 XRP)
 * @returns {Promise<void>} Promise that resolves when funding is complete or not needed
 * @throws {Error} Error if funding fails
 */
export async function refuelWalletFromFaucet(
  wallet,
  client,
  minBalance = 5
) {
  let xrplClient = client;
  let shouldDisconnect = false;

  try {
    // Create client if not provided
    if (!xrplClient) {
      xrplClient = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
      await xrplClient.connect();
      shouldDisconnect = true;
    }

    // Check current balance
    try {
      const response = await xrplClient.request({
        command: "account_info",
        account: wallet.address,
        ledger_index: "validated"
      });

      const currentBalance = Number(xrpl.dropsToXrp(response.result.account_data.Balance));
      console.log(`Wallet ${wallet.address} current balance: ${currentBalance} XRP`);

      if (currentBalance >= minBalance) {
        console.log(`Wallet ${wallet.address} has sufficient balance, skipping funding`);
        return;
      }
    } catch (error) {
      // Account might not exist yet, proceed with funding
      console.log(`Wallet ${wallet.address} account not found, proceeding with funding`);
    }

    // Fund the wallet using testnet faucet
    console.log(`Funding wallet ${wallet.address} from testnet faucet...`);
    await xrplClient.fundWallet(wallet);
    console.log(`Successfully funded wallet ${wallet.address}`);

  } catch (error) {
    throw new Error(`Failed to fund wallet ${wallet.address}: ${error}`);
  } finally {
    // Disconnect if we created the client
    if (shouldDisconnect && xrplClient) {
      await xrplClient.disconnect();
    }
  }
}