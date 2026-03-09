import csv
import time
import os
import json
from datetime import datetime

from bot.config import BotConfig
from bot.market_data import fetch_btc_context
from bot.strategy import AccumulatorStrategy

CONFIG_FILE = "config.json"


def load_runtime_config():
    if not os.path.exists(CONFIG_FILE):
        return None
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


class BotRunner:
    def __init__(self, config: BotConfig):
        self.config = config
        self.strategy = AccumulatorStrategy(config)

        os.makedirs("data", exist_ok=True)
        self.log_file = "data/btc_accumulator_log.csv"

        if not os.path.exists(self.log_file):
            with open(self.log_file, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow([
                    "time",
                    "price",
                    "funding",
                    "action",
                    "order_usd",
                    "btc_position",
                    "total_cost_usd",
                    "avg_entry_price",
                    "market_value_usd",
                    "unrealized_pnl_usd",
                ])

    def _sleep_with_stop_check(self, total_seconds: int):
        """
        長い sleep を1秒刻みに分解して、Stop が押されたら即抜ける。
        """
        for _ in range(max(1, int(total_seconds))):
            cfg = load_runtime_config()
            if not cfg:
                return
            if not cfg.get("running", False):
                print("BOT stop detected during sleep.", flush=True)
                return
            time.sleep(1)

    def run(self):
        while True:
            cfg = load_runtime_config()

            if not cfg:
                print("config.json が見つからないため待機しています...", flush=True)
                time.sleep(2)
                continue

            # ダッシュボードの設定をBOTへ反映
            self.config.base_order_usd = float(cfg.get("base_order_usd", 25))
            self.config.max_daily_usd = float(cfg.get("max_daily_usd", 200))
            self.config.cycle_seconds = int(cfg.get("cycle_minutes", 5)) * 60

            # 停止中なら何もせず待機
            if not cfg.get("running", False):
                print("BOT is stopped. waiting...", flush=True)
                time.sleep(1)
                continue

            market = fetch_btc_context()
            decision = self.strategy.decide(market)

            if decision["action"] == "buy":
                self.strategy.mark_executed(
                    decision["order_usd"],
                    market["markPx"]
                )

            portfolio = self.strategy.get_portfolio(market["markPx"])

            print("market:", market, flush=True)
            print("decision:", decision, flush=True)
            print("portfolio:", portfolio, flush=True)

            with open(self.log_file, "a", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow([
                    datetime.utcnow(),
                    market["markPx"],
                    market["funding"],
                    decision["action"],
                    decision["order_usd"],
                    portfolio["btc_position"],
                    portfolio["total_cost_usd"],
                    portfolio["avg_entry_price"],
                    portfolio["market_value_usd"],
                    portfolio["unrealized_pnl_usd"],
                ])

            # 次回実行まで待つが、Stopが押されたら即抜ける
            self._sleep_with_stop_check(self.config.cycle_seconds)