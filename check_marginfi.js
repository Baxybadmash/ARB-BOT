require('dotenv').config();
const { getConfig, MarginfiClient } = require('@mrgnlabs/marginfi-client-v2');
const { NodeWallet } = require('@mrgnlabs/mrgn-common');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');

const SOL_BANK_ADDRESS = 'CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh';

async function tryFetch(rpcUrl, label) {
    try {
        const connection = new Connection(rpcUrl, 'confirmed');
        const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
        const nodeWallet = new NodeWallet(wallet);
        const config = getConfig('production');
        const client = await MarginfiClient.fetch(config, nodeWallet, connection, {
            preloadedBankAddresses: [new PublicKey(SOL_BANK_ADDRESS)],
        });
        console.log(`✅ [${label}] loaded. Banks: ${client.banks.size}`);
        const accounts = await client.getMarginfiAccountsForAuthority(wallet.publicKey);
        console.log(`   MFI accounts: ${accounts.length}`);
        accounts.forEach((a, i) => console.log(`   [${i}] ${a.address.toString()} flashLoanEnabled=${a.isFlashLoanEnabled}`));
        return true;
    } catch (e) {
        console.log(`❌ [${label}] failed: ${e.message.split('\n')[0]}`);
        return false;
    }
}

async function main() {
    await tryFetch(process.env.RPC_URL_PRIMARY, 'Helius');
    await tryFetch(process.env.RPC_URL_SECONDARY, 'Shyft');
}

main().catch(e => console.error(e.message));
