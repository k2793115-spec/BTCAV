class AccumulatorStrategy:

    def __init__(self, config):
        self.config = config
        self.daily_spent = 0.0

        # 仮想ポートフォリオ
        self.btc_position = 0.0
        self.total_cost_usd = 0.0

    def decide(self, market):

        order_usd = self.config.base_order_usd
        funding = market["funding"]

        reasons = ["base_dca"]

        if funding > 0.0001:
            order_usd *= 0.5
            reasons.append("funding_hot_reduce")

        if funding < -0.0001:
            order_usd *= 1.5
            reasons.append("funding_cold_increase")

        if self.daily_spent + order_usd > self.config.max_daily_usd:
            return {
                "action": "skip",
                "order_usd": 0.0,
                "reason": ["daily_cap"],
            }

        return {
            "action": "buy",
            "order_usd": round(order_usd, 2),
            "reason": reasons,
        }

    def mark_executed(self, usd, price):
        btc_bought = usd / price

        self.daily_spent += usd
        self.total_cost_usd += usd
        self.btc_position += btc_bought

    def get_portfolio(self, current_price):
        avg_entry = 0.0
        market_value = 0.0
        unrealized_pnl = 0.0

        if self.btc_position > 0:
            avg_entry = self.total_cost_usd / self.btc_position
            market_value = self.btc_position * current_price
            unrealized_pnl = market_value - self.total_cost_usd

        return {
            "btc_position": round(self.btc_position, 8),
            "total_cost_usd": round(self.total_cost_usd, 2),
            "avg_entry_price": round(avg_entry, 2),
            "market_value_usd": round(market_value, 2),
            "unrealized_pnl_usd": round(unrealized_pnl, 2),
        }