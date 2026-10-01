"""
NBC Customer Command Center — Flask backend.

Serves the single-page dashboard and the JSON API it consumes.
No model inference — all values come from the pre-scored CSVs.
"""
from __future__ import annotations

import math
from datetime import datetime

import pandas as pd
from flask import Flask, abort, jsonify, render_template

from data import (
    INSURANCE_PROFILE_COLS,
    NBC_SIGNAL_COLS,
    TERM_PROFILE_COLS,
    get_store,
)

app = Flask(__name__)
store = get_store()


# -----------------------------------------------------------------------------
# Serialization helpers
# -----------------------------------------------------------------------------
def safe_value(value, fallback: str = "—") -> str:
    if value is None:
        return fallback
    try:
        if pd.isna(value):
            return fallback
    except (TypeError, ValueError):
        pass
    if isinstance(value, float):
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
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return "—"
    return parsed.strftime("%d %b %Y")


def normalize_prediction(value) -> str:
    if value is None:
        return "—"
    try:
        if pd.isna(value):
            return "—"
    except (TypeError, ValueError):
        pass
    raw = str(value).strip().upper()
    if raw in {"YES", "Y", "1", "1.0", "TRUE", "INTERESTED"}:
        return "YES"
    if raw in {"NO", "N", "0", "0.0", "FALSE", "NOT INTERESTED"}:
        return "NO"
    return str(value)


def fmt_score(value, percent: bool = True) -> str:
    if value is None:
        return "—"
    try:
        if pd.isna(value):
            return "—"
    except (TypeError, ValueError):
        pass
    try:
        n = float(value)
    except (TypeError, ValueError):
        return safe_value(value)
    if percent and 0 <= n <= 1:
        return f"{n * 100:.1f}%"
    return f"{n:.2f}"


def affinity_pct(value) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(n):
        return 0.0
    if 0 <= n <= 1:
        return max(0.0, min(100.0, n * 100))
    if 0 <= n <= 100:
        return max(0.0, min(100.0, n))
    return 0.0


def nice_label(col: str, prefix: str = "") -> str:
    name = col.replace(prefix, "", 1) if prefix and col.startswith(prefix) else col
    return name.replace("_", " ").title()


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def api_meta():
    return jsonify({
        "snapshot_date": short_date(store.snapshot_date()),
        "customer_count": int(store.main["synthetic_link_id"].nunique()),
        "history_rows": int(len(store.history)),
    })


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

    # ---- hero ----
    hero = {
        "id": cid,
        "score_date": short_date(customer.get("nbc_score_date")),
        "channel": safe_value(customer.get("preferred_channel")),
        "last_action_date": short_date(customer.get("last_action_date")),
    }

    # ---- NBC ----
    nbc = {
        "nbc1": safe_value(customer.get("NBC1")),
        "nbc2": safe_value(customer.get("NBC2")),
        "nbc3": safe_value(customer.get("NBC3")),
    }

    # ---- predictions ----
    term_pred = normalize_prediction(customer.get("Term Deposit Prediction"))
    ins_pred = normalize_prediction(customer.get("Insurance Prediction"))
    term_aff = customer.get("offer_affinity_score_term")
    ins_aff = customer.get("offer_affinity_score_insurance")
    predictions = {
        "term": {
            "label": term_pred,
            "is_yes": term_pred == "YES",
            "affinity_display": fmt_score(term_aff),
            "affinity_width": affinity_pct(term_aff),
        },
        "insurance": {
            "label": ins_pred,
            "is_yes": ins_pred == "YES",
            "affinity_display": fmt_score(ins_aff),
            "affinity_width": affinity_pct(ins_aff),
        },
    }

    # ---- context strip ----
    context = {
        "last_action": safe_value(customer.get("last_action_taken")),
        "channel": safe_value(customer.get("preferred_channel")),
        "action_date": short_date(customer.get("last_action_date")),
    }

    # ---- interaction ----
    interaction_payload = None
    if interaction is not None:
        interaction_payload = {
            "date": short_date(interaction["last_interaction_date"]),
            "text": safe_value(interaction["last_interaction_text"]),
        }

    # ---- history insight (compact) ----
    history_payload = None
    if not history.empty:
        states = history["NBC1"].fillna("Blank").astype(str)
        counts = states.value_counts()
        dominant = counts.index[0]
        dominant_count = int(counts.iloc[0])
        total = int(len(history))
        first_state = states.iloc[0]
        latest_state = states.iloc[-1]
        matches = (nbc["nbc1"] != "—") and (latest_state == nbc["nbc1"])

        history_payload = {
            "total": total,
            "dominant": dominant,
            "dominant_count": dominant_count,
            "distinct": int(counts.shape[0]),
            "first": first_state,
            "latest": latest_state,
            "matches_current": matches,
            "counts": [{"state": str(k), "value": int(v)} for k, v in counts.items()],
            "points": [
                {
                    "point": int(p) if pd.notna(p) else None,
                    "date": short_date(d),
                    "state": str(s),
                }
                for p, d, s in zip(
                    history["point_in_time"], history["nbc_date"],
                    history["NBC1"].fillna("Blank").astype(str),
                )
            ],
        }

    # ---- NBC signals ----
    signals = []
    for col in NBC_SIGNAL_COLS:
        if col not in customer.index:
            continue
        value = safe_value(customer[col])
        if col in {"offer_affinity_score_term", "offer_affinity_score_insurance",
                   "channel_affinity_score", "churn_score"}:
            value = fmt_score(customer[col])
        elif col == "nps_score":
            value = f"{fmt_score(customer[col], percent=False)} / 10"
        elif col in {"product_margin_term_deposit", "product_margin_insurance"}:
            value = fmt_score(customer[col], percent=False)
        signals.append({"label": nice_label(col), "value": value})

    # ---- profile tables ----
    def profile_rows(cols, prefix):
        out = []
        for c in cols:
            if c not in customer.index:
                continue
            out.append({"field": nice_label(c, prefix), "value": safe_value(customer[c])})
        return out

    term_profile = profile_rows(TERM_PROFILE_COLS, "term_")
    insurance_profile = profile_rows(INSURANCE_PROFILE_COLS, "motor_")

    return jsonify({
        "hero": hero,
        "nbc": nbc,
        "predictions": predictions,
        "context": context,
        "interaction": interaction_payload,
        "history_insight": history_payload,
        "signals": signals,
        "term_profile": term_profile,
        "insurance_profile": insurance_profile,
    })


@app.route("/api/portfolio")
def api_portfolio():
    """
    Fixed portfolio-level NBC1 composition across all 18 historical points.

    This endpoint is intentionally independent of the selected customer.
    """
    return jsonify(store.portfolio_top3_by_point())


if __name__ == "__main__":
    app.run(debug=True, port=5234)
