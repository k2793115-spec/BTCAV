import { readFileSync } from "node:fs";

import {
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { deserializePermissionAccount } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";

import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

type Artifact = {
  chainId: number;
  chainName: string;
  zerodevRpc: string;
  arbitrumRpcUrl: string;
  entryPoint: string;
  kernelVersion: string;
  ownerAddress: string;
  smartAccountAddress: string;
  sessionKeyAddress: string;
  sessionPrivateKey: `0x${string}`;
  serializedPermissionApproval: string;
  createdAt: string;
  policy?: {
    target: string;
    function: string;
  };
};

const EXECUTOR = "0x3f1b308Be305b3B5359Da9C9B1d568F6c84B5a81" as const;
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const;

const USDC = {
  address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const,
  decimals: 6,
  symbol: "USDC",
};

const WBTC = {
  address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f" as const,
  decimals: 8,
  symbol: "WBTC",
};

const POOL_FEE = 500;
const AMOUNT_IN_HUMAN = "0.1";
const SLIPPAGE_BPS = 100n;
const DEADLINE_DELAY_SECONDS = 300n;

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const executorAbi = [
  {
    type: "function",
    name: "executeDca",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "quotedAmountOut", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

function loadArtifact(): Artifact {
  const raw = readFileSync(
    "/workspaces/BTCAV/aa-bootstrap/session-artifact.arbitrum-one.json",
    "utf8"
  );
  return JSON.parse(raw) as Artifact;
}

function normalizeQuoteResult(output: any) {
  if (Array.isArray(output)) {
    return {
      amountOut: output[0] as bigint,
      sqrtPriceX96After: output[1] as bigint,
      initializedTicksCrossed: output[2] as number,
      gasEstimate: output[3] as bigint,
    };
  }

  return {
    amountOut: output.amountOut as bigint,
    sqrtPriceX96After: output.sqrtPriceX96After as bigint,
    initializedTicksCrossed: output.initializedTicksCrossed as number,
    gasEstimate: output.gasEstimate as bigint,
  };
}

function calcMinAmountOutFloor(
  quotedAmountOut: bigint,
  slippageBps: bigint
): bigint {
  return (quotedAmountOut * (10_000n - slippageBps)) / 10_000n;
}

async function main() {
  const artifact = loadArtifact();
  const chain = arbitrum;

  console.log("artifact loaded");
  console.log("chain:", artifact.chainName, artifact.chainId);
  console.log("owner EOA:", artifact.ownerAddress);
  console.log("smart account:", artifact.smartAccountAddress);
  console.log("session key address:", artifact.sessionKeyAddress);
  console.log("executor:", EXECUTOR);

  const publicClient = createPublicClient({
    chain,
    transport: http(artifact.arbitrumRpcUrl),
  });

  const sessionKeyAccount = privateKeyToAccount(artifact.sessionPrivateKey);

  const realSessionSigner = await toECDSASigner({
    signer: sessionKeyAccount,
  });

  const permissionAccount = await deserializePermissionAccount(
    publicClient,
    artifact.entryPoint as `0x${string}`,
    artifact.kernelVersion,
    artifact.serializedPermissionApproval,
    realSessionSigner
  );

  console.log("permission account restored:", permissionAccount.address);

  const amountIn = parseUnits(AMOUNT_IN_HUMAN, USDC.decimals);
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_DELAY_SECONDS;

  const executorUsdcBefore = await publicClient.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [EXECUTOR],
  });

  const recipientWbtcBefore = await publicClient.readContract({
    address: WBTC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [artifact.smartAccountAddress as `0x${string}`],
  });

  console.log(
    "executor USDC before:",
    formatUnits(executorUsdcBefore, USDC.decimals),
    USDC.symbol
  );
  console.log(
    "recipient WBTC before:",
    formatUnits(recipientWbtcBefore, WBTC.decimals),
    WBTC.symbol
  );

  if (executorUsdcBefore < amountIn) {
    throw new Error(
      `executor USDC balance is insufficient. need=${AMOUNT_IN_HUMAN} have=${formatUnits(
        executorUsdcBefore,
        USDC.decimals
      )}`
    );
  }

  const quoteSimulation = await publicClient.simulateContract({
    address: QUOTER_V2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: USDC.address,
        tokenOut: WBTC.address,
        amountIn,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0,
      },
    ],
    account: artifact.smartAccountAddress as `0x${string}`,
  });

  const quote = normalizeQuoteResult(quoteSimulation.result);
  const minAmountOut = calcMinAmountOutFloor(quote.amountOut, SLIPPAGE_BPS);

  console.log("amountIn:", AMOUNT_IN_HUMAN, USDC.symbol);
  console.log(
    "quoted amountOut:",
    formatUnits(quote.amountOut, WBTC.decimals),
    WBTC.symbol
  );
  console.log(
    "min amountOut:",
    formatUnits(minAmountOut, WBTC.decimals),
    WBTC.symbol
  );
  console.log("quoter gasEstimate:", quote.gasEstimate.toString());
  console.log("deadline unix:", deadline.toString());

  const paymasterClient = createZeroDevPaymasterClient({
    chain,
    transport: http(artifact.zerodevRpc),
  });

  const kernelClient = createKernelAccountClient({
    account: permissionAccount,
    chain,
    bundlerTransport: http(artifact.zerodevRpc),
    paymaster: {
      async getPaymasterData(userOperation) {
        return paymasterClient.sponsorUserOperation({ userOperation });
      },
    },
  });

  const executeCalldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "executeDca",
    args: [amountIn, quote.amountOut, minAmountOut, deadline],
  });

  console.log("sending executor.executeDca user operation...");

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await permissionAccount.encodeCalls([
      {
        to: EXECUTOR,
        value: 0n,
        data: executeCalldata,
      },
    ]),
  });

  console.log("userOp hash:", userOpHash);

  const receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  console.log("tx hash:", receipt.receipt.transactionHash);

  const executorUsdcAfter = await publicClient.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [EXECUTOR],
  });

  const recipientWbtcAfter = await publicClient.readContract({
    address: WBTC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [artifact.smartAccountAddress as `0x${string}`],
  });

  console.log(
    "executor USDC after:",
    formatUnits(executorUsdcAfter, USDC.decimals),
    USDC.symbol
  );
  console.log(
    "recipient WBTC after:",
    formatUnits(recipientWbtcAfter, WBTC.decimals),
    WBTC.symbol
  );

  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});