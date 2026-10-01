"""
Loads the three NBC CSVs into memory once, at import time.
Exposes helper functions for querying them.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "Banking Datasets - Marketing Targets" / "historic_nbcs"

MAIN_DATA_PATH = DATA_DIR / "main_dataset_scored_20sep2026.csv"
INTERACTION_DATA_PATH = DATA_DIR / "customer_last_interaction.csv"
HISTORY_DATA_PATH = DATA_DIR / "nbc1_historic_18points_long.csv"


# -----------------------------------------------------------------------------
# Column contracts
# -----------------------------------------------------------------------------
MAIN_REQUIRED = [
    "synthetic_link_id",
    "Term Deposit Prediction",
    "Insurance Prediction",
    "NBC1",
    "NBC2",
    "NBC3",
    "nbc_score_date",
    "last_action_taken",
    "last_action_date",
]

INTERACTION_REQUIRED = [
    "synthetic_link_id",
    "last_interaction_date",
    "last_interaction_text",
]

HISTORY_REQUIRED = [
    "synthetic_link_id",
    "point_in_time",
    "nbc_date",
    "NBC1",
]

TERM_PROFILE_COLS = [
    "term_age",
    "term_job",
    "term_marital",
    "term_education",
    "term_default",
    "term_balance",
    "term_housing",
    "term_loan",
    "term_contact",
    "term_day",
    "term_month",
    "term_duration",
    "term_campaign",
    "term_pdays",
    "term_previous",
    "term_poutcome",
    "term_y",
]

INSURANCE_PROFILE_COLS = [
    "motor_Gender",
    "motor_Age",
    "motor_Driving_License",
    "motor_Region_Code",
    "motor_Previously_Insured",
    "motor_Vehicle_Age",
    "motor_Vehicle_Damage",
    "motor_Annual_Premium",
    "motor_Policy_Sales_Channel",
    "motor_Vintage",
    "motor_Response",
]

NBC_SIGNAL_COLS = [
    "kyc_status",
    "marketing_consent_flag",
    "aml_fraud_flag",
    "dpd_days",
    "collections_flag",
    "open_complaint_flag",
    "churn_score",
    "nps_score",
    "strategic_campaign_active_flag",
    "strategic_campaign_product",
    "preapproval_flag",
    "preapproved_product",
    "offer_affinity_score_term",
    "offer_affinity_score_insurance",
    "product_margin_term_deposit",
    "product_margin_insurance",
    "preferred_channel",
    "channel_affinity_score",
]


# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------
def _require(df: pd.DataFrame, cols: list[str], filename: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError(
            f"{filename} is missing columns: {', '.join(missing)}"
        )


# -----------------------------------------------------------------------------
# Date parsing
# -----------------------------------------------------------------------------
def _parse_day_first_date_series(series: pd.Series) -> pd.Series:
    """
    Parse source dates with an explicit day-first interpretation.

    Handles:
        10/09/2026
        10-09-2026
        10/09/2026 00:00:00
        10-09-2026 00:00:00

    Values without a recognizable day/month/year pattern become NaT.
    """
    values = series.astype("string").str.strip()

    extracted = values.str.extract(
        r"(?P<day>\d{1,2})[/-](?P<month>\d{1,2})[/-](?P<year>\d{4})",
        expand=True,
    )

    day = pd.to_numeric(extracted["day"], errors="coerce")
    month = pd.to_numeric(extracted["month"], errors="coerce")
    year = pd.to_numeric(extracted["year"], errors="coerce")

    normalized = (
        day.astype("Int64").astype("string").str.zfill(2)
        + "/"
        + month.astype("Int64").astype("string").str.zfill(2)
        + "/"
        + year.astype("Int64").astype("string")
    )

    return pd.to_datetime(
        normalized,
        format="%d/%m/%Y",
        errors="coerce",
    )


# -----------------------------------------------------------------------------
# Data store
# -----------------------------------------------------------------------------
class DataStore:
    def __init__(self) -> None:
        if not MAIN_DATA_PATH.exists():
            raise FileNotFoundError(f"Missing {MAIN_DATA_PATH.name}")

        # Main scored dataset
        self.main = pd.read_csv(MAIN_DATA_PATH)
        _require(self.main, MAIN_REQUIRED, MAIN_DATA_PATH.name)

        self.main["nbc_score_date"] = _parse_day_first_date_series(
            self.main["nbc_score_date"]
        )
        self.main["last_action_date"] = _parse_day_first_date_series(
            self.main["last_action_date"]
        )

        # Customer interaction dataset
        if not INTERACTION_DATA_PATH.exists():
            raise FileNotFoundError(f"Missing {INTERACTION_DATA_PATH.name}")

        self.interactions = pd.read_csv(INTERACTION_DATA_PATH)
        _require(
            self.interactions,
            INTERACTION_REQUIRED,
            INTERACTION_DATA_PATH.name,
        )

        self.interactions["last_interaction_date"] = (
            _parse_day_first_date_series(
                self.interactions["last_interaction_date"]
            )
        )

        # Historical NBC1 dataset
        if not HISTORY_DATA_PATH.exists():
            raise FileNotFoundError(f"Missing {HISTORY_DATA_PATH.name}")

        self.history = pd.read_csv(HISTORY_DATA_PATH)
        _require(
            self.history,
            HISTORY_REQUIRED,
            HISTORY_DATA_PATH.name,
        )

        self.history["point_in_time"] = pd.to_numeric(
            self.history["point_in_time"],
            errors="coerce",
        )
        self.history["nbc_date"] = _parse_day_first_date_series(
            self.history["nbc_date"]
        )

        # Customer IDs
        self.main["synthetic_link_id"] = (
            self.main["synthetic_link_id"].astype(str)
        )
        self.interactions["synthetic_link_id"] = (
            self.interactions["synthetic_link_id"].astype(str)
        )
        self.history["synthetic_link_id"] = (
            self.history["synthetic_link_id"].astype(str)
        )

        # Fast customer lookup
        self._main_by_id = self.main.set_index(
            "synthetic_link_id",
            drop=False,
        )

    # -------------------------------------------------------------------------
    # Customer queries
    # -------------------------------------------------------------------------
    def customer_ids(self) -> list[str]:
        return sorted(
            self.main["synthetic_link_id"]
            .dropna()
            .unique()
            .tolist()
        )

    def snapshot_date(self):
        s = self.main["nbc_score_date"].dropna()
        return s.iloc[0] if not s.empty else None

    def get_customer(self, cid: str) -> pd.Series | None:
        if cid not in self._main_by_id.index:
            return None

        row = self._main_by_id.loc[cid]

        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]

        return row

    def get_interaction(self, cid: str):
        rows = self.interactions.loc[
            self.interactions["synthetic_link_id"] == cid
        ]

        if rows.empty:
            return None

        return rows.sort_values(
            "last_interaction_date",
            ascending=False,
        ).iloc[0]

    def get_history(self, cid: str) -> pd.DataFrame:
        rows = self.history.loc[
            self.history["synthetic_link_id"] == cid
        ].copy()

        return rows.sort_values(
            ["point_in_time", "nbc_date"]
        )

    # -------------------------------------------------------------------------
    # Fixed portfolio history for the NBC History tab
    # -------------------------------------------------------------------------
    def portfolio_top3_by_point(self) -> dict:
        """
        Build the fixed portfolio view requested for the NBC History tab.

        For each point:
          1. count customers by NBC1
          2. rank NBC1 states by customer count
          3. retain only the top three states

        The result is independent of the selected customer.
        """
        frame = self.history[
            ["point_in_time", "nbc_date", "NBC1"]
        ].copy()

        frame["NBC1"] = frame["NBC1"].fillna("Blank").astype(str)

        counts = (
            frame.groupby(
                ["point_in_time", "NBC1"],
                dropna=False,
            )
            .size()
            .reset_index(name="customers")
        )

        counts = counts.sort_values(
            ["point_in_time", "customers", "NBC1"],
            ascending=[True, False, True],
        )

        counts["rank"] = (
            counts.groupby("point_in_time", sort=False)
            .cumcount()
            .add(1)
        )

        top3 = counts.loc[counts["rank"] <= 3].copy()

        points = sorted(
            int(p)
            for p in top3["point_in_time"].dropna().unique()
        )

        # One representative NBC date per point.
        point_dates: dict[int, str] = {}
        for point in points:
            rows = frame.loc[
                frame["point_in_time"] == point,
                "nbc_date",
            ].dropna()

            point_dates[point] = (
                rows.iloc[0].strftime("%d %b %Y")
                if not rows.empty
                else "—"
            )

        # Stable series/legend order based on total customers represented
        # across the retained top-3 states, then alphabetical tie-break.
        state_order = (
            top3.groupby("NBC1")["customers"]
            .sum()
            .sort_values(ascending=False)
        )
        states = state_order.index.tolist()

        series = []
        for state in states:
            values = []

            for point in points:
                match = top3.loc[
                    (top3["point_in_time"] == point)
                    & (top3["NBC1"] == state),
                    "customers",
                ]

                values.append(
                    int(match.iloc[0])
                    if not match.empty
                    else 0
                )

            series.append(
                {
                    "state": str(state),
                    "values": values,
                }
            )

        # Useful for hover/readout validation.
        top3_lookup: dict[str, list[dict]] = {}

        for point in points:
            rows = top3.loc[
                top3["point_in_time"] == point
            ].sort_values(
                ["customers", "NBC1"],
                ascending=[False, True],
            )

            top3_lookup[str(point)] = [
                {
                    "state": str(row["NBC1"]),
                    "customers": int(row["customers"]),
                }
                for _, row in rows.iterrows()
            ]

        return {
            "points": points,
            "point_dates": [point_dates[p] for p in points],
            "series": series,
            "top3_by_point": top3_lookup,
        }

    def portfolio_counts(self, top: int = 10) -> pd.Series:
        """
        Backward-compatible overall NBC1 counts.
        """
        states = (
            self.history["NBC1"]
            .fillna("Blank")
            .astype(str)
        )

        return states.value_counts().head(top)


# -----------------------------------------------------------------------------
# Singleton datastore
# -----------------------------------------------------------------------------
@lru_cache(maxsize=1)
def get_store() -> DataStore:
    return DataStore()
