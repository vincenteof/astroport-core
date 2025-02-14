import 'dotenv/config'
import {
    newClient,
    writeArtifact,
    readArtifact,
    deployContract,
    executeContract,
    uploadContract, instantiateContract,
} from './helpers.js'
import { join } from 'path'
import {LCDClient} from '@terra-money/terra.js';

const ARTIFACTS_PATH = '../artifacts'

async function main() {
    const { terra, wallet } = newClient()
    console.log(`chainID: ${terra.config.chainID} wallet: ${wallet.key.accAddress}`)
    let network = readArtifact(terra.config.chainID)
    console.log('network:', network)

    if (!network.tokenAddress) {
        console.log(`Please deploy the CW20-base ASTRO token, and then set this address in the deploy config before running this script...`)
        return
    }

    if (!network.multisigAddress) {
        console.log(`Set the proper owner multisig for the contracts`)
        return
    }

    await uploadAndInitTreasury(terra, wallet)
    await uploadPairContracts(terra, wallet)
    await uploadAndInitStaking(terra, wallet)
    await uploadAndInitFactory(terra, wallet)
    await uploadAndInitRouter(terra, wallet)
    await uploadAndInitMaker(terra, wallet)

    // Set new owner
    network = readArtifact(terra.config.chainID) // reload variables
    console.log('Propose a new owner for the factory. Onwership has to be claimed within 7 days')
    await executeContract(terra, wallet, network.factoryAddress, {
        "propose_new_owner": {
            owner: network.multisigAddress,
            expires_in: 604800 // 7 days
        }
    })

    console.log('FINISH')
}

async function uploadAndInitTreasury(terra: LCDClient, wallet: any) {
    let network = readArtifact(terra.config.chainID)

    if (!network.treasuryCodeID) {
        console.log('Register Treasury Contract...')
        network.treasuryCodeID = await uploadContract(terra, wallet, join(ARTIFACTS_PATH, 'astroport_whitelist.wasm')!)
    }

    if (!network.treasuryAddress) {
        console.log('Instantiate the Treasury...')
        let resp = await instantiateContract(
            terra,
            wallet,
            network.multisigAddress,
            network.treasuryCodeID,
            {
                admins: [network.assemblyAddress],
                mutable: true
            });
        network.treasuryAddress = resp.shift()
        console.log(`Treasure Contract Address: ${network.treasuryAddress}`)
        writeArtifact(network, terra.config.chainID)
    }
}

async function uploadPairContracts(terra: LCDClient, wallet: any) {
    let network = readArtifact(terra.config.chainID)

    if (!network.pairCodeID) {
        console.log('Register Pair Contract...')
        network.pairCodeID = await uploadContract(terra, wallet, join(ARTIFACTS_PATH, 'astroport_pair.wasm')!)
        writeArtifact(network, terra.config.chainID)
    }

    if (!network.pairStableCodeID) {
        console.log('Register Stable Pair Contract...')
        network.pairStableCodeID = await uploadContract(terra, wallet, join(ARTIFACTS_PATH, 'astroport_pair_stable.wasm')!)
        writeArtifact(network, terra.config.chainID)
    }

    if (!network.pairAnchorCodeID) {
        console.log('Register Anchor Pair Contract...')
        network.pairAnchorCodeID = await uploadContract(terra, wallet, join(ARTIFACTS_PATH, 'astroport_pair_anchor.wasm')!)
        writeArtifact(network, terra.config.chainID)
    }
}

async function uploadAndInitStaking(terra: LCDClient, wallet: any) {
    let network = readArtifact(terra.config.chainID)

    if (!network.xastroTokenCodeID) {
        console.log('Register xASTRO token contract...')
        network.xastroTokenCodeID = await uploadContract(terra, wallet, join(ARTIFACTS_PATH, 'astroport_xastro_token.wasm')!)
        writeArtifact(network, terra.config.chainID)
    }

    if (!network.stakingAddress) {
        console.log('Deploy Staking...')

        let resp = await deployContract(
            terra,
            wallet,
            network.multisigAddress,
            join(ARTIFACTS_PATH, 'astroport_staking.wasm'),
            {
                owner: network.multisigAddress,
                token_code_id: network.xastroTokenCodeID,
                deposit_token_addr:  network.tokenAddress,
            }
        )

        network.stakingAddress = resp.shift()
        network.xastroAddress = resp.shift();

        console.log(`Staking Contract Address: ${network.stakingAddress}`)
        console.log(`xASTRO token Address: ${network.xastroAddress}`)
        writeArtifact(network, terra.config.chainID)
    }
}

async function uploadAndInitFactory(terra: LCDClient, wallet: any) {
    let network = readArtifact(terra.config.chainID)

    if (!network.factoryAddress) {
        console.log('Deploy the Factory...')
        console.log(`CodeId Pair Contract: ${network.pairCodeID} CodeId Stable Pair Contract: ${network.pairStableCodeID} CodeId Anchor Pair Contract: ${network.pairAnchorCodeID}`)

        let resp = await deployContract(
            terra,
            wallet,
            network.multisigAddress,
            join(ARTIFACTS_PATH, 'astroport_factory.wasm'),
            {
                owner: wallet.key.accAddress, // We don't set multisig as owner, as we need to update maker address once it is deployed
                pair_configs: [
                    {
                        code_id: network.pairCodeID,
                        pair_type: { xyk: {} },
                        total_fee_bps: 30, // 0.3% xyk
                        maker_fee_bps: 3333, // 1/3rd of xyk fees go to maker
                        is_disabled: false,
                        is_generator_disabled: false
                    },
                    {
                        code_id: network.pairStableCodeID,
                        pair_type: { stable: {} },
                        total_fee_bps: 5, // 0.05% stableswap
                        maker_fee_bps: 5000, // 50% of stableswap fees go to the Maker
                        is_disabled: false,
                        is_generator_disabled: false
                    },
                    {
                        code_id: network.pairAnchorCodeID,
                        pair_type: { custom: "Anchor-XYK" },
                        total_fee_bps: 0,
                        maker_fee_bps: 0,
                        is_disabled: false,
                        is_generator_disabled: true
                    }
                ],
                token_code_id: network.tokenCodeID,
                generator_address: undefined,
                fee_address: undefined,
                whitelist_code_id: network.treasuryCodeID
            }
        )
        network.factoryAddress = resp.shift()
        console.log(`Address Factory Contract: ${network.factoryAddress}`)
        writeArtifact(network, terra.config.chainID)
    }
}

async function uploadAndInitRouter(terra: LCDClient, wallet: any) {
    let network = readArtifact(terra.config.chainID)

    if (!network.routerAddress) {
        console.log('Deploy the Router...')
        let resp = await deployContract(
            terra,
            wallet,
            network.multisigAddress,
            join(ARTIFACTS_PATH, 'astroport_router.wasm'),
            {
                astroport_factory: network.factoryAddress,
            },
        )
        network.routerAddress = resp.shift()
        console.log(`Router Contract Address: ${network.routerAddress}`)
        writeArtifact(network, terra.config.chainID)
    }
}

async function uploadAndInitMaker(terra: LCDClient, wallet: any) {
    let network = readArtifact(terra.config.chainID)

    if (!network.makerAddress) {
        console.log('Deploy the Maker...')
        let resp = await deployContract(
            terra,
            wallet,
            network.multisigAddress,
            join(ARTIFACTS_PATH, 'astroport_maker.wasm'),
            {
                owner: network.multisigAddress,
                factory_contract: String(network.factoryAddress),
                staking_contract: String(network.stakingAddress),
                astro_token_contract: String(network.tokenAddress),
            }
        )
        network.makerAddress = resp.shift()
        console.log(`Maker Contract Address: ${network.makerAddress}`)
        writeArtifact(network, terra.config.chainID)

        // Set maker address in factory
        console.log('Set the Maker and the proper owner address in the factory')
        await executeContract(terra, wallet, network.factoryAddress, {
            "update_config": {
                fee_address: network.makerAddress
            }
        })
    }
}

main().catch(console.log)
