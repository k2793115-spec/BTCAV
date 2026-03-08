import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { arbitrum } from "wagmi/chains";
import { formatUnits, parseUnits } from "viem";

const ARBITRUM_CHAIN_ID = 42161;

const USDC = {
  address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  symbol: "USDC",
  decimals: 6,
};

const WBTC = {
  address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
  symbol: "WBTC",
  decimals: 8,
};

const SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

const FEE_TIERS = [500, 3000, 10000];
const DEFAULT_SLIPPAGE_PERCENT = "1.0";
const DEADLINE_SECONDS = 60 * 10;
const QUOTE_DEBOUNCE_MS = 500;

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

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
];

const swapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

function shortenAddress(value) {
  if (!value) return "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatBigintToken(value, decimals, maximumFractionDigits = 8) {
  try {
    const s = formatUnits(value ?? 0n, decimals);
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    return n.toLocaleString(undefined, { maximumFractionDigits });
  } catch {
    return "-";
  }
}

function parseSlippageToBps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 100n;
  return BigInt(Math.round(n * 100));
}

function normalizeQuoteResult(output) {
  if (Array.isArray(output)) {
    return {
      amountOut: output[0],
      sqrtPriceX96After: output[1],
      initializedTicksCrossed: output[2],
      gasEstimate: output[3],
    };
  }

  return {
    amountOut: output.amountOut,
    sqrtPriceX96After: output.sqrtPriceX96After,
    initializedTicksCrossed: output.initializedTicksCrossed,
    gasEstimate: output.gasEstimate,
  };
}

export default function App() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connectAsync, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [amountInInput, setAmountInInput] = useState("10");
  const [slippagePercent, setSlippagePercent] = useState(DEFAULT_SLIPPAGE_PERCENT);

  const [status, setStatus] = useState("待機中");
  const [quoteError, setQuoteError] = useState("");
  const [quote, setQuote] = useState(null);

  const [approveHash, setApproveHash] = useState("");
  const [swapHash, setSwapHash] = useState("");

  const [isApproving, setIsApproving] = useState(false);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);

  const latestQuoteRequestIdRef = useRef(0);

  const isOnArbitrum = chainId === ARBITRUM_CHAIN_ID;

  const amountIn = useMemo(() => {
    try {
      if (!amountInInput || Number(amountInInput) <= 0) return 0n;
      return parseUnits(amountInInput, USDC.decimals);
    } catch {
      return 0n;
    }
  }, [amountInInput]);

  const slippageBps = useMemo(() => {
    return parseSlippageToBps(slippagePercent);
  }, [slippagePercent]);

  const quoteKey = useMemo(() => {
    return `${amountIn.toString()}-${slippageBps.toString()}`;
  }, [amountIn, slippageBps]);

  const usdcBalance = useBalance({
    address,
    token: USDC.address,
    chainId: ARBITRUM_CHAIN_ID,
    query: {
      enabled: Boolean(address),
    },
  });

  const wbtcBalance = useBalance({
    address,
    token: WBTC.address,
    chainId: ARBITRUM_CHAIN_ID,
    query: {
      enabled: Boolean(address),
    },
  });

  const allowanceQuery = useReadContract({
    abi: erc20Abi,
    address: USDC.address,
    functionName: "allowance",
    args: address ? [address, SWAP_ROUTER] : undefined,
    chainId: ARBITRUM_CHAIN_ID,
    query: {
      enabled: Boolean(address),
    },
  });

  const allowance = allowanceQuery.data ?? 0n;
  const hasValidAmount = amountIn > 0n;
  const hasEnoughAllowance = allowance >= amountIn && amountIn > 0n;

  const isQuoteFresh = Boolean(
    quote &&
      quote.quoteKey === quoteKey &&
      quote.amountIn === amountIn &&
      quote.slippageBps === slippageBps
  );

  const canApprove =
    isConnected &&
    isOnArbitrum &&
    hasValidAmount &&
    !isApproving &&
    !hasEnoughAllowance;

  const canSwap =
    isConnected &&
    isOnArbitrum &&
    hasValidAmount &&
    hasEnoughAllowance &&
    isQuoteFresh &&
    !isQuoting &&
    !isSwapping;

  useEffect(() => {
    if (!isConnected) {
      setQuote(null);
      setQuoteError("");
      setApproveHash("");
      setSwapHash("");
      setStatus("待機中");
      return;
    }
  }, [isConnected]);

  useEffect(() => {
    setQuote(null);
    setQuoteError("");

    if (!isConnected) return;
    if (!isOnArbitrum) return;
    if (!address) return;
    if (!publicClient) return;
    if (!hasValidAmount) return;

    const requestId = latestQuoteRequestIdRef.current + 1;
    latestQuoteRequestIdRef.current = requestId;

    const timer = setTimeout(async () => {
      try {
        setIsQuoting(true);
        setQuoteError("");
        setStatus("最新見積りを取得中...");

        let best = null;
        const errors = [];

        for (const fee of FEE_TIERS) {
          try {
            const result = await publicClient.simulateContract({
              address: QUOTER_V2,
              abi: quoterV2Abi,
              functionName: "quoteExactInputSingle",
              args: [
                {
                  tokenIn: USDC.address,
                  tokenOut: WBTC.address,
                  amountIn,
                  fee,
                  sqrtPriceLimitX96: 0,
                },
              ],
              account: address,
            });

            const normalized = normalizeQuoteResult(result.result);

            if (!best || normalized.amountOut > best.amountOut) {
              best = {
                fee,
                ...normalized,
              };
            }
          } catch (error) {
            console.error(`quote failed fee=${fee}`, error);
            errors.push(`fee=${fee}`);
          }
        }

        if (latestQuoteRequestIdRef.current !== requestId) {
          return;
        }

        if (!best) {
          throw new Error(
            `見積り取得に失敗しました。利用可能 pool がない可能性があります。 ${errors.join(", ")}`
          );
        }

        const amountOutMinimum =
          (best.amountOut * (10000n - slippageBps)) / 10000n;

        setQuote({
          ...best,
          amountIn,
          amountOutMinimum,
          slippageBps,
          quoteKey,
        });

        setStatus(`見積り更新済み。採用 fee tier: ${best.fee}`);
      } catch (error) {
        if (latestQuoteRequestIdRef.current !== requestId) {
          return;
        }

        console.error(error);
        setQuote(null);
        setQuoteError(
          error?.shortMessage || error?.message || "見積り取得に失敗しました。"
        );
        setStatus("見積り取得に失敗しました。");
      } finally {
        if (latestQuoteRequestIdRef.current === requestId) {
          setIsQuoting(false);
        }
      }
    }, QUOTE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    isConnected,
    isOnArbitrum,
    address,
    publicClient,
    hasValidAmount,
    amountIn,
    slippageBps,
    quoteKey,
  ]);

  async function handleConnect() {
    try {
      const connector = connectors?.[0];
      if (!connector) {
        setStatus("接続用コネクタが見つかりません。");
        return;
      }

      setStatus("ウォレット接続中...");
      await connectAsync({ connector });
      setStatus("ウォレット接続完了。");
    } catch (error) {
      console.error(error);
      setStatus(error?.shortMessage || error?.message || "ウォレット接続に失敗しました。");
    }
  }

  async function handleSwitchChain() {
    try {
      setStatus("Arbitrum へ切り替え中...");
      await switchChainAsync({ chainId: arbitrum.id });
      setStatus("Arbitrum に切り替えました。");
    } catch (error) {
      console.error(error);
      setStatus(error?.shortMessage || error?.message || "チェーン切り替えに失敗しました。");
    }
  }

  async function handleApprove() {
    if (!address) {
      setStatus("先にウォレットを接続してください。");
      return;
    }
    if (!isOnArbitrum) {
      setStatus("先に Arbitrum に切り替えてください。");
      return;
    }
    if (!hasValidAmount) {
      setStatus("USDC 数量が不正です。");
      return;
    }

    try {
      setIsApproving(true);
      setStatus("Approve を送信中...");
      setApproveHash("");

      const hash = await writeContractAsync({
        chainId: ARBITRUM_CHAIN_ID,
        address: USDC.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [SWAP_ROUTER, amountIn],
      });

      setApproveHash(hash);
      setStatus(`Approve 送信済み: ${hash}`);

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash });
      }

      await allowanceQuery.refetch();
      setStatus("Approve 完了。");
    } catch (error) {
      console.error(error);
      setStatus(error?.shortMessage || error?.message || "Approve に失敗しました。");
    } finally {
      setIsApproving(false);
    }
  }

  async function handleSwap() {
    if (!address) {
      setStatus("先にウォレットを接続してください。");
      return;
    }
    if (!isOnArbitrum) {
      setStatus("先に Arbitrum に切り替えてください。");
      return;
    }
    if (!hasValidAmount) {
      setStatus("USDC 数量が不正です。");
      return;
    }
    if (!hasEnoughAllowance) {
      setStatus("Approve が不足しています。");
      return;
    }
    if (!quote || !isQuoteFresh) {
      setStatus("最新の見積りが揃うまで待ってください。");
      return;
    }

    try {
      setIsSwapping(true);
      setSwapHash("");
      setStatus("Swap を送信中...");

      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

      const hash = await writeContractAsync({
        chainId: ARBITRUM_CHAIN_ID,
        address: SWAP_ROUTER,
        abi: swapRouterAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: USDC.address,
            tokenOut: WBTC.address,
            fee: quote.fee,
            recipient: address,
            deadline,
            amountIn: quote.amountIn,
            amountOutMinimum: quote.amountOutMinimum,
            sqrtPriceLimitX96: 0,
          },
        ],
      });

      setSwapHash(hash);
      setStatus(`Swap 送信済み: ${hash}`);

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash });
      }

      await Promise.all([
        allowanceQuery.refetch(),
        usdcBalance.refetch(),
        wbtcBalance.refetch(),
      ]);

      setStatus("Swap 完了。");
    } catch (error) {
      console.error(error);
      setStatus(error?.shortMessage || error?.message || "Swap に失敗しました。");
    } finally {
      setIsSwapping(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b1020",
        color: "#e5e7eb",
        padding: "24px",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ maxWidth: "980px", margin: "0 auto" }}>
        <h1 style={{ marginTop: 0, fontSize: "32px" }}>BTC積立BOT Prototype</h1>
        <div style={{ color: "#9ca3af", marginBottom: "24px" }}>
          Arbitrum / USDC → WBTC / Uniswap v3
        </div>

        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>1. Wallet</h2>

          {!isConnected ? (
            <button onClick={handleConnect} disabled={isConnecting} style={buttonStyle}>
              {isConnecting ? "接続中..." : "MetaMask を接続"}
            </button>
          ) : (
            <div style={{ display: "grid", gap: "10px" }}>
              <div>Address: {shortenAddress(address)}</div>
              <div>
                Chain: {chainId} {isOnArbitrum ? "✅ Arbitrum" : "⚠️ Arbitrumではない"}
              </div>

              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                {!isOnArbitrum && (
                  <button onClick={handleSwitchChain} style={buttonStyle}>
                    Arbitrum に切り替え
                  </button>
                )}
                <button
                  onClick={() => {
                    disconnect();
                    setStatus("ウォレットを切断しました。");
                  }}
                  style={secondaryButtonStyle}
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}
        </section>

        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>2. Balances</h2>

          <div style={{ display: "grid", gap: "8px" }}>
            <div>
              USDC:{" "}
              {usdcBalance.isLoading
                ? "Loading..."
                : usdcBalance.data
                  ? usdcBalance.data.formatted
                  : "-"}
            </div>
            <div>
              WBTC:{" "}
              {wbtcBalance.isLoading
                ? "Loading..."
                : wbtcBalance.data
                  ? wbtcBalance.data.formatted
                  : "-"}
            </div>
            <div>
              Allowance to Router:{" "}
              {allowanceQuery.isLoading
                ? "Loading..."
                : `${formatBigintToken(allowance, USDC.decimals, 6)} ${USDC.symbol}`}
            </div>
          </div>
        </section>

        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>3. Swap Test</h2>

          <div style={{ display: "grid", gap: "14px" }}>
            <label style={labelStyle}>
              <div style={{ marginBottom: "6px" }}>USDC投入量</div>
              <input
                type="text"
                value={amountInInput}
                onChange={(e) => setAmountInInput(e.target.value)}
                placeholder="10"
                style={inputStyle}
              />
            </label>

            <label style={labelStyle}>
              <div style={{ marginBottom: "6px" }}>Slippage %</div>
              <input
                type="text"
                value={slippagePercent}
                onChange={(e) => setSlippagePercent(e.target.value)}
                placeholder="1.0"
                style={inputStyle}
              />
            </label>

            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              {!hasEnoughAllowance ? (
                <button
                  onClick={handleApprove}
                  disabled={!canApprove}
                  style={buttonStyle}
                >
                  {isApproving
                    ? "Approve中..."
                    : `Approve ${amountInInput || "0"} USDC`}
                </button>
              ) : (
                <button
                  onClick={handleSwap}
                  disabled={!canSwap}
                  style={buttonStyle}
                >
                  {isSwapping ? "Swap中..." : "Swap 実行"}
                </button>
              )}
            </div>

            {isQuoting && (
              <div style={{ color: "#93c5fd" }}>最新入力で見積り更新中...</div>
            )}

            {!hasEnoughAllowance && hasValidAmount && (
              <div style={{ color: "#f59e0b" }}>
                現在の投入量に対する allowance が不足しています。Approve が必要です。
              </div>
            )}

            {hasEnoughAllowance && !isQuoteFresh && hasValidAmount && (
              <div style={{ color: "#f59e0b" }}>
                入力変更後の最新見積りを取得中です。完了後に Swap できます。
              </div>
            )}

            {quoteError && (
              <div style={{ color: "#fca5a5", whiteSpace: "pre-wrap" }}>
                {quoteError}
              </div>
            )}

            {quote && (
              <div style={quoteBoxStyle}>
                <div>
                  Quote対象入力: {formatBigintToken(quote.amountIn, USDC.decimals, 6)} {USDC.symbol}
                </div>
                <div>採用 fee tier: {quote.fee}</div>
                <div>
                  Estimated Amount Out: {formatBigintToken(quote.amountOut, WBTC.decimals, 8)}{" "}
                  {WBTC.symbol}
                </div>
                <div>
                  Amount Out Minimum:{" "}
                  {formatBigintToken(quote.amountOutMinimum, WBTC.decimals, 8)} {WBTC.symbol}
                </div>
                <div>Slippage: {(Number(quote.slippageBps) / 100).toFixed(2)}%</div>
                <div>Quoter Gas Estimate: {String(quote.gasEstimate)}</div>
                <div>Ticks Crossed: {String(quote.initializedTicksCrossed)}</div>
                <div style={{ color: isQuoteFresh ? "#86efac" : "#f59e0b" }}>
                  {isQuoteFresh ? "最新見積りです" : "古い見積りです"}
                </div>
              </div>
            )}
          </div>
        </section>

        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>4. Status</h2>

          <div style={{ display: "grid", gap: "8px" }}>
            <div style={{ whiteSpace: "pre-wrap" }}>{status}</div>

            {approveHash && (
              <div>
                Approve Tx:{" "}
                <a
                  href={`https://arbiscan.io/tx/${approveHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={linkStyle}
                >
                  {shortenAddress(approveHash)}
                </a>
              </div>
            )}

            {swapHash && (
              <div>
                Swap Tx:{" "}
                <a
                  href={`https://arbiscan.io/tx/${swapHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={linkStyle}
                >
                  {shortenAddress(swapHash)}
                </a>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const cardStyle = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: "16px",
  padding: "20px",
  marginBottom: "20px",
};

const sectionTitleStyle = {
  marginTop: 0,
  marginBottom: "16px",
};

const buttonStyle = {
  background: "#2563eb",
  color: "#ffffff",
  border: "none",
  borderRadius: "10px",
  padding: "12px 16px",
  cursor: "pointer",
  fontWeight: 600,
};

const secondaryButtonStyle = {
  ...buttonStyle,
  background: "#374151",
};

const inputStyle = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "10px",
  border: "1px solid #374151",
  background: "#0f172a",
  color: "#e5e7eb",
  fontSize: "16px",
  boxSizing: "border-box",
};

const labelStyle = {
  display: "block",
};

const quoteBoxStyle = {
  border: "1px solid #374151",
  borderRadius: "12px",
  padding: "16px",
  background: "#0f172a",
  display: "grid",
  gap: "8px",
};

const linkStyle = {
  color: "#60a5fa",
  textDecoration: "none",
};