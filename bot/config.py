from dataclasses import dataclass

@dataclass
class BotConfig:
    coin: str = "BTC"
    mode: str = "paper"
    cycle_seconds: int = 300
    base_order_usd: float = 25.0
    max_daily_usd: float = 200.0
    