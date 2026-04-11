const { Connection, Keypair, PublicKey, AddressLookupTableProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config({ path: '/home/ubuntu/ARB-BOT/.env' });

(async () => {
    const conn = new Connection(process.env.RPC_URL_PRIMARY, 'confirmed');
    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    console.log('Wallet:', wallet.publicKey.toBase58());

    const addresses = [
        '11111111111111111111111111111111',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        'ComputeBudget111111111111111111111111111111',
        'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
        'Sysvar1nstructions1111111111111111111111111',
        '9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo',
        '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
        'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q',
        'GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U',
        '3JNof8s453bwG5UqiXBLJc77NRQXezYYEBbk3fqnoKph',
        'So11111111111111111111111111111111111111112',
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        'DQwQCSZL4Wm98FKdbVVw1Vq5txLcKNfxRBQrsy2MtcSa',
        '8ChvMvALunCZrZnbr3Jwf4S8kEKYAqcMGL2C53MFgK87',
        '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
        'ES7yhSrYeFo4U1PfJHNRkbfCWxCwPLk2DjrEbmN8bg58',
        '4dmvFGeQH2eqa3ktNHMgm4wZ8vuTukBiK9M7gxW5oR9F',
        'GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN',
        'E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp',
        '2wzaFLYb4JcDrVs8TfU3TfkVwq1Pdp3rRgWdNJzFGXud',
        'GDnBvA76ZAJ2K3en2F1iExPZ6qz83Xjj5srXMmSKTYDW',
        'Gj8gzDNKmf5y3p1LorKHTvMZ8eCLhbCDnhGiN5xVW8Jq',
    ];

    console.log('Adding ' + addresses.length + ' addresses to ALT');
    const pubkeys = addresses.map((a, i) => {
        try { return new PublicKey(a); }
        catch (e) { console.error('Bad address at index ' + i + ': ' + a); process.exit(1); }
    });

    const slot = await conn.getSlot('finalized');
    const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
        authority: wallet.publicKey,
        payer: wallet.publicKey,
        recentSlot: slot - 1,
    });

    const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: wallet.publicKey,
        authority: wallet.publicKey,
        lookupTable: altAddress,
        addresses: pubkeys,
    });

    const bh = await conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: [createIx, extendIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    console.log('Tx size: ' + Buffer.from(tx.serialize()).length + ' bytes');

    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    console.log('ALT address: ' + altAddress.toBase58());
    console.log('Signature: ' + sig);
    console.log('Waiting for confirmation...');
    await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    console.log('CONFIRMED. ALT is live.');
    console.log('Add this to .env:');
    console.log('ALT_ADDRESS=' + altAddress.toBase58());
})().catch(e => { console.error(e); process.exit(1); });
