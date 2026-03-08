import "dotenv/config";

import { writeFileSync } from "node:fs";

import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toInitConfig,
  toPermissionValidator,
} from "@zerodev/permissions";
import {
  CallPolicyVersion,
  toCallPolicy,
} from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  addressToEmptyAccount,
  createKernelAccount,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";

import {
  createPublicClient,
  http,
  toFunctionSelector,
} from "viem";
import { arbitrum } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const EXECUTOR = "0x3eD3D79c44b4ce08f874f43964649341F1912542" as const;

function must(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

async function main() {
  const ZERODEV_RPC = must("ZERODEV_RPC");
  const OWNER_PRIVATE_KEY = must("OWNER_PRIVATE_KEY") as `0x${string}`;
  const ARBITRUM_RPC_URL = (process.env.ARBITRUM_RPC_URL || ZERODEV_RPC).trim();
  const SESSION_PRIVATE_KEY =
    ((process.env.SESSION_PRIVATE_KEY?.trim() as `0x${string}` | undefined) ||
      (generatePrivateKey() as `0x${string}`));

  console.log("OWNER_PRIVATE_KEY length:", OWNER_PRIVATE_KEY.length);
  console.log("OWNER_PRIVATE_KEY startsWith0x:", OWNER_PRIVATE_KEY.startsWith("0x"));

  const chain = arbitrum;
  const kernelVersion = KERNEL_V3_3;
  const entryPoint = getEntryPoint("0.7");

  const publicClient = createPublicClient({
    chain,
    transport: http(ARBITRUM_RPC_URL),
  });

  const ownerSigner = privateKeyToAccount(OWNER_PRIVATE_KEY);
  const sessionKeyAccount = privateKeyToAccount(SESSION_PRIVATE_KEY);

  console.log("owner EOA:", ownerSigner.address);
  console.log("session key address:", sessionKeyAccount.address);
  console.log("policy target executor:", EXECUTOR);
  console.log("policy function:", "executeDca(uint256,uint256,uint256,uint256)");

  const ownerEmptyAccount = addressToEmptyAccount(ownerSigner.address);

  const sudoValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerEmptyAccount,
    entryPoint,
    kernelVersion,
  });

  const emptySessionAccount = addressToEmptyAccount(sessionKeyAccount.address);
  const emptySessionSigner = await toECDSASigner({
    signer: emptySessionAccount,
  });

  // ここでは target + selector だけに絞る
  // 金額やrecipient等の安全性は Executor コントラクト側で onchain 強制
  const callPolicy = toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions: [
      {
        target: EXECUTOR,
        valueLimit: 0n,
        selector: toFunctionSelector("executeDca(uint256,uint256,uint256,uint256)"),
      },
    ],
  });

  const permissionPlugin = await toPermissionValidator(publicClient, {
    entryPoint,
    signer: emptySessionSigner,
    policies: [callPolicy],
    kernelVersion,
  });

  const kernelAccount = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: {
      sudo: sudoValidator,
    },
    kernelVersion,
    initConfig: await toInitConfig(permissionPlugin),
  });

  console.log("kernel smart account:", kernelAccount.address);

  const serializedApproval = await serializePermissionAccount(
    kernelAccount,
    undefined,
    undefined,
    undefined,
    permissionPlugin
  );

  const realSessionSigner = await toECDSASigner({
    signer: sessionKeyAccount,
  });

  const permissionAccount = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    kernelVersion,
    serializedApproval,
    realSessionSigner
  );

  console.log("permission account restored:", permissionAccount.address);

  const artifact = {
    chainId: chain.id,
    chainName: chain.name,
    zerodevRpc: ZERODEV_RPC,
    arbitrumRpcUrl: ARBITRUM_RPC_URL,
    entryPoint,
    kernelVersion,
    ownerAddress: ownerSigner.address,
    smartAccountAddress: kernelAccount.address,
    sessionKeyAddress: sessionKeyAccount.address,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    serializedPermissionApproval: serializedApproval,
    policy: {
      target: EXECUTOR,
      function: "executeDca(uint256,uint256,uint256,uint256)",
    },
    createdAt: new Date().toISOString(),
  };

  writeFileSync(
    "./session-artifact.arbitrum-one.json",
    JSON.stringify(artifact, null, 2),
    "utf8"
  );

  console.log("saved: session-artifact.arbitrum-one.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});