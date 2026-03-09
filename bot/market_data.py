import requests

URL = "https://api.hyperliquid.xyz/info"

def fetch_btc_context():
    response = requests.post(URL, json={"type": "metaAndAssetCtxs"}, timeout=10)
    response.raise_for_status()
    data = response.json()

    universe = data[0]["universe"]
    ctxs = data[1]

    btc_index = next(i for i, asset in enumerate(universe) if asset["name"] == "BTC")
    btc = ctxs[btc_index]

    return {
        "coin": "BTC",
        "markPx": float(btc["markPx"]),
        "oraclePx": float(btc["oraclePx"]),
        "funding": float(btc["funding"]),
        "openInterest": float(btc["openInterest"]),
        "dayNtlVlm": float(btc["dayNtlVlm"]),
    }