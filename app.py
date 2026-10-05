"""
NBC Customer Command Center — Flask backend.

Read-only presentation layer over the pre-scored NBC snapshot and the two
supporting customer/history datasets.
"""
from __future__ import annotations

import math
from datetime import datetime

import pandas as pd
from flask import Flask, abort, jsonify, render_template

from data import (
    INSURANCE_PROFILE_COLS,
    TERM_PROFILE_COLS,
    get_store,
)


app = Flask(__name__)
store = get_store()


def safe_value(value, fallback: str = "—") -> str:
    if value is None:
        return fallback

    try:
        if pd.isna(value):
            return fallback
    except (TypeError, ValueError):
        pass

    if isinstance(value, float):
        if math.isnan(value):
            return fallback
        if value.is_integer():
            return str(int(value))
        return f"{value:.4f}".rstrip("0").rstrip(".")

    if isinstance(value, (pd.Timestamp, datetime)):
        return value.strftime("%d %b %Y")

    return str(value)


def short_date(value) -> str:
    if value is None:
        return "—"

    try:
        if pd.isna(value):
            return "—"
    except (TypeError, ValueError):
        pass

    if isinstance(value, (pd.Timestamp, datetime)):
        return value.strftime("%d %b %Y")

    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return "—"

    return parsed.strftime("%d %b %Y")


def nice_label(field: str, prefix: str = "") -> str:
    name = str(field)
    if prefix and name.lower().startswith(prefix.lower()):
        name = name[len(prefix):]

    name = name.replace("_", " ").strip()
    return name.title()


def build_profile(rows: list[dict], prefix: str) -> list[dict]:
    return [
        {
            "field": nice_label(row["field"], prefix),
            "raw_field": row["field"],
            "value": safe_value(row["value"]),
        }
        for row in rows
    ]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def api_meta():
    return jsonify(
        {
            "snapshot_date": short_date(store.snapshot_date()),
            "customer_count": int(
                store.main["synthetic_link_id"].nunique()
            ),
            "history_rows": int(len(store.history)),
        }
    )


@app.route("/api/customers")
def api_customers():
    return jsonify({"ids": store.customer_ids()})


@app.route("/api/customer/<cid>")
def api_customer(cid: str):
    customer = store.get_customer(cid)
    if customer is None:
        abort(404, description="Customer not found")

    interaction = store.get_interaction(cid)
    history = store.get_history(cid)

    nbc1 = safe_value(customer.get("NBC1"))
    nbc2 = safe_value(customer.get("NBC2"))
    nbc3 = safe_value(customer.get("NBC3"))

    interaction_payload = None
    if interaction is not None:
        interaction_payload = {
            "date": short_date(interaction["last_interaction_date"]),
            "text": safe_value(interaction["last_interaction_text"]),
        }

    history_payload = None
    if not history.empty:
        states = history["NBC1"].fillna("Blank").astype(str)
        counts = states.value_counts()

        latest_state = states.iloc[-1]
        history_payload = {
            "total": int(len(history)),
            "dominant": str(counts.index[0]),
            "dominant_count": int(counts.iloc[0]),
            "distinct": int(counts.shape[0]),
            "first": str(states.iloc[0]),
            "latest": str(latest_state),
            "matches_current": (
                nbc1 != "—" and latest_state == nbc1
            ),
            "counts": [
                {
                    "state": str(state),
                    "value": int(value),
                }
                for state, value in counts.items()
            ],
            "points": [
                {
                    "point": int(point)
                    if pd.notna(point)
                    else None,
                    "date": short_date(date),
                    "state": str(state),
                }
                for point, date, state in zip(
                    history["point_in_time"],
                    history["nbc_date"],
                    history["NBC1"].fillna("Blank").astype(str),
                )
            ],
        }

    return jsonify(
        {
            "hero": {
                "id": cid,
                "score_date": short_date(customer.get("nbc_score_date")),
                "channel": safe_value(customer.get("preferred_channel")),
                "last_action_date": short_date(
                    customer.get("last_action_date")
                ),
            },
            "nbc": {
                "nbc1": nbc1,
                "nbc2": nbc2,
                "nbc3": nbc3,
            },
            "activity": {
                "last_action": safe_value(
                    customer.get("last_action_taken")
                ),
                "channel": safe_value(
                    customer.get("preferred_channel")
                ),
                "action_date": short_date(
                    customer.get("last_action_date")
                ),
            },
            "interaction": interaction_payload,
            "term_profile": build_profile(
                store.get_term_profile(cid),
                "term_",
            ),
            "insurance_profile": build_profile(
                store.get_insurance_profile(cid),
                "motor_",
            ),
            "history": history_payload,
        }
    )


@app.route("/api/portfolio")
def api_portfolio():
    return jsonify(store.portfolio_top3_by_point())


if __name__ == "__main__":
    app.run(debug=True, port=5234)