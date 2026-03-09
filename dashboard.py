import os
import json
import pandas as pd
import streamlit as st
from streamlit_autorefresh import st_autorefresh

CONFIG_FILE="config.json"
LOG_FILE="data/btc_accumulator_log.csv"

def load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    with open(CONFIG_FILE) as f:
        return json.load(f)

def save_config(cfg):
    with open(CONFIG_FILE,"w") as f:
        json.dump(cfg,f,indent=2)

st.set_page_config(page_title="BTC積立BOT",layout="wide")

st_autorefresh(interval=5000,key="refresh")

cfg=load_config()

running=cfg.get("running",False)
base_order_usd=cfg.get("base_order_usd",25)
cycle_minutes=cfg.get("cycle_minutes",5)
max_daily_usd=cfg.get("max_daily_usd",200)
mode=cfg.get("mode","paper")

st.title("BTC積立BOT")

if not os.path.exists(LOG_FILE):
    st.warning("BOTログがありません")
    st.stop()

df=pd.read_csv(LOG_FILE)

latest=df.iloc[-1]

price=float(latest["price"])
btc=float(latest["btc_position"])
cost=float(latest["total_cost_usd"])
avg=float(latest["avg_entry_price"])
value=float(latest["market_value_usd"])
pnl=float(latest["unrealized_pnl_usd"])

roi=(value-cost)/cost*100 if cost>0 else 0

start_price=df.iloc[0]["price"]
btc_roi=(price-start_price)/start_price*100

alpha=roi-btc_roi

status="🟢 稼働中" if running else "🔴 停止中"

c1,c2,c3,c4=st.columns(4)

with c1:
    st.metric("BTC価格",f"${price:,.0f}")

with c2:
    st.metric("累計BTC",f"{btc:.6f}")

with c3:
    st.metric("累計投資額",f"${cost:,.0f}")

with c4:
    st.metric("評価額",f"${value:,.0f}")

c5,c6,c7,c8=st.columns(4)

with c5:
    st.metric("BOT ROI",f"{roi:.2f}%")

with c6:
    st.metric("BTC ROI",f"{btc_roi:.2f}%")

with c7:
    st.metric("BOT優位",f"{alpha:.2f}%")

with c8:
    st.metric("BOT状態",status)

st.divider()

left,right=st.columns(2)

with left:

    st.subheader("積立設定")

    buy_amount=st.number_input(
        "1回の購入額",
        value=base_order_usd,
        step=5.0
    )

    cycle_minutes=st.selectbox(
        "実行間隔(分)",
        [1,5,10,15,30,60],
        index=[1,5,10,15,30,60].index(cycle_minutes)
    )

    max_daily=st.number_input(
        "1日の最大投資額",
        value=max_daily_usd,
        step=50.0
    )

    mode=st.radio(
        "モード",
        ["paper","spot","perp"],
        index=["paper","spot","perp"].index(mode),
        horizontal=True
    )

with right:

    st.subheader("操作")

    a,b,c=st.columns(3)

    with a:
        if st.button("Start"):
            cfg["running"]=True
            save_config(cfg)

    with b:
        if st.button("Stop"):
            cfg["running"]=False
            save_config(cfg)

    with c:
        if st.button("設定保存"):
            cfg["base_order_usd"]=buy_amount
            cfg["cycle_minutes"]=cycle_minutes
            cfg["max_daily_usd"]=max_daily
            cfg["mode"]=mode
            save_config(cfg)

st.divider()

g1,g2=st.columns(2)

with g1:

    st.subheader("BTC価格推移")

    st.line_chart(df.set_index("time")["price"])

with g2:

    st.subheader("資産推移")

    st.line_chart(
        df.set_index("time")[["market_value_usd","total_cost_usd"]]
    )

st.subheader("累計BTC推移")

st.line_chart(
    df.set_index("time")["btc_position"]
)

st.subheader("履歴")

st.dataframe(df)