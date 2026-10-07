"""
NBC Command Center data layer.

Loads the three NBC CSVs once and exposes customer and portfolio queries.
The dashboard is read-only: no model inference is executed at runtime.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import re

import pandas as pd

not_an_important_flag = "mypc" # keeping this flag just for my convenience. You can ignore it for now, as mostly you are running it on VM so keep it `vm` in that case

if not_an_important_flag == "vm":
    BASE_DIR = Path(__file__).resolve().parent.parent
    DATA_DIR = BASE_DIR / "Banking Datasets - Marketing Targets" / "historic_nbcs"

elif not_an_important_flag == "mypc":
    BASE_DIR = Path(__file__).resolve().parent
    DATA_DIR = BASE_DIR / "Data"

MAIN_DATA_PATH = DATA_DIR / "main_dataset_scored_20sep2026.csv"
INTERACTION_DATA_PATH = DATA_DIR / "customer_last_interaction.csv"
HISTORY_DATA_PATH = DATA_DIR / "nbc1_historic_18points_long.csv"
JOURNEY_DATA_PATH = DATA_DIR / "customer_journey_timeline.csv"


MAIN_REQUIRED = [
    "synthetic_link_id",
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

JOURNEY_REQUIRED = [
    "synthetic_link_id",
    "checkpoint_seq",
    "event_date",
    "event_stage",
    "event_type",
    "event_title",
    "event_description",
    "product",
    "channel",
    "status",
]

# Holdings are derived from the main file flags. The journey file's
# "Product Holding" events were verified to agree with these flags 1:1.
PRODUCTS = [
    # key, label, journey event_type carrying the "since" date
    ("term_deposit", "Term Deposit", "TD_SUBSCRIBED"),
    ("housing_loan", "Housing Loan", "HOUSING_LOAN_ACTIVE"),
    ("personal_loan", "Personal Loan", "PERSONAL_LOAN_ACTIVE"),
    ("motor_insurance", "Motor Insurance", "MOTOR_INSURANCE_CROSSSOLD"),
]
HOLDING_SOURCE_COLS = ["term_y", "term_housing", "term_loan", "motor_Response"]

AGE_BINS = [0, 24, 34, 44, 54, 64, 200]
AGE_LABELS = ["<25", "25-34", "35-44", "45-54", "55-64", "65+"]
MIN_GROUP_N = 30  # below this a group mean is flagged as unstable
MIN_PREMIUM_N = 10  # premium is only defined for policyholders (small cells)

PORTFOLIO_DIMENSIONS = {
    "age": "Age group",
    "job": "Occupation",
    "education": "Education",
    "marital": "Marital status",
}

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


def _clean_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Remove BOM/whitespace around column names without changing their meaning."""
    df = df.copy()
    df.columns = [
        re.sub(r"^\ufeff+", "", str(col)).strip()
        for col in df.columns
    ]
    return df


def _require(df: pd.DataFrame, cols: list[str], filename: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError(
            f"{filename} is missing required columns: {', '.join(missing)}"
        )


def _parse_day_first_date_series(series: pd.Series) -> pd.Series:
    """
    Parse DD/MM/YYYY or DD-MM-YYYY values explicitly.

    Trailing time text is ignored, e.g.:
        10/09/2026 00:00:00
        10-09-2026 00:00:00
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


def _num(value, digits: int = 1):
    """JSON-safe number: NaN/None -> None (jsonify would emit invalid NaN)."""
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        return None
    return round(float(value), digits)


def _normalise_id(series: pd.Series) -> pd.Series:
    return series.astype("string").str.strip()


def _normalised_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower())


def _resolve_column(columns, requested: str) -> str | None:
    """Resolve exact, case-insensitive, then punctuation-insensitive column names."""
    if requested in columns:
        return requested

    requested_lower = requested.lower()
    for col in columns:
        if str(col).lower() == requested_lower:
            return col

    target = _normalised_name(requested)
    for col in columns:
        if _normalised_name(col) == target:
            return col

    return None


class DataStore:
    def __init__(self) -> None:
        if not MAIN_DATA_PATH.exists():
            raise FileNotFoundError(f"Missing {MAIN_DATA_PATH}")

        if not INTERACTION_DATA_PATH.exists():
            raise FileNotFoundError(f"Missing {INTERACTION_DATA_PATH}")

        if not HISTORY_DATA_PATH.exists():
            raise FileNotFoundError(f"Missing {HISTORY_DATA_PATH}")

        if not JOURNEY_DATA_PATH.exists():
            raise FileNotFoundError(f"Missing {JOURNEY_DATA_PATH}")

        self.main = _clean_columns(pd.read_csv(MAIN_DATA_PATH, skipinitialspace=True))
        self.interactions = _clean_columns(
            pd.read_csv(INTERACTION_DATA_PATH, skipinitialspace=True)
        )
        self.history = _clean_columns(
            pd.read_csv(HISTORY_DATA_PATH, skipinitialspace=True)
        )

        self.journey = _clean_columns(
            pd.read_csv(JOURNEY_DATA_PATH, skipinitialspace=True)
        )

        _require(self.main, MAIN_REQUIRED + HOLDING_SOURCE_COLS, MAIN_DATA_PATH.name)
        _require(self.journey, JOURNEY_REQUIRED, JOURNEY_DATA_PATH.name)
        _require(self.interactions, INTERACTION_REQUIRED, INTERACTION_DATA_PATH.name)
        _require(self.history, HISTORY_REQUIRED, HISTORY_DATA_PATH.name)

        self.main["synthetic_link_id"] = _normalise_id(
            self.main["synthetic_link_id"]
        )
        self.interactions["synthetic_link_id"] = _normalise_id(
            self.interactions["synthetic_link_id"]
        )
        self.history["synthetic_link_id"] = _normalise_id(
            self.history["synthetic_link_id"]
        )

        # The journey file is space-padded in headers and values.
        for col in self.journey.columns:
            if pd.api.types.is_string_dtype(self.journey[col]) or self.journey[col].dtype == object:
                self.journey[col] = self.journey[col].astype("string").str.strip()
        self.journey["synthetic_link_id"] = _normalise_id(
            self.journey["synthetic_link_id"]
        )
        self.journey["event_date"] = _parse_day_first_date_series(
            self.journey["event_date"]
        )
        self.journey["checkpoint_seq"] = pd.to_numeric(
            self.journey["checkpoint_seq"], errors="coerce"
        )

        self.main["nbc_score_date"] = _parse_day_first_date_series(
            self.main["nbc_score_date"]
        )
        self.main["last_action_date"] = _parse_day_first_date_series(
            self.main["last_action_date"]
        )
        self.interactions["last_interaction_date"] = _parse_day_first_date_series(
            self.interactions["last_interaction_date"]
        )
        self.history["nbc_date"] = _parse_day_first_date_series(
            self.history["nbc_date"]
        )
        self.history["point_in_time"] = pd.to_numeric(
            self.history["point_in_time"],
            errors="coerce",
        )

        self._main_by_id = self.main.set_index(
            "synthetic_link_id",
            drop=False,
        )

        self._enriched = self._build_enriched()
        self._portfolio_product_cache: dict[str, dict] = {}

    # ----------------------------------------------------------
    # Product holdings
    # ----------------------------------------------------------
    def _build_enriched(self) -> pd.DataFrame:
        """Main frame + boolean holding flags + products_held + age band."""
        df = self.main.drop_duplicates("synthetic_link_id").copy()

        def yes(col: str) -> pd.Series:
            return df[col].astype("string").str.strip().str.lower().eq("yes").fillna(False)

        df["has_term_deposit"] = yes("term_y")
        df["has_housing_loan"] = yes("term_housing")
        df["has_personal_loan"] = yes("term_loan")
        df["has_motor_insurance"] = (
            pd.to_numeric(df["motor_Response"], errors="coerce").fillna(0).eq(1)
        )
        df["products_held"] = df[[f"has_{k}" for k, _, _ in PRODUCTS]].sum(axis=1)

        df["term_balance"] = pd.to_numeric(df["term_balance"], errors="coerce")
        df["motor_Annual_Premium"] = pd.to_numeric(
            df["motor_Annual_Premium"], errors="coerce"
        )
        df["age_group"] = pd.cut(
            pd.to_numeric(df["term_age"], errors="coerce"),
            bins=AGE_BINS,
            labels=AGE_LABELS,
        ).astype("string")
        return df.set_index("synthetic_link_id", drop=False)

    def get_journey(self, cid: str) -> pd.DataFrame:
        rows = self.journey.loc[self.journey["synthetic_link_id"] == cid]
        return rows.sort_values(["checkpoint_seq", "event_date"])

    def get_customer_products(self, cid: str) -> dict | None:
        if cid not in self._enriched.index:
            return None
        row = self._enriched.loc[cid]
        journey = self.get_journey(cid)

        def since(event_type: str):
            hit = journey.loc[journey["event_type"] == event_type, "event_date"]
            return hit.iloc[0] if not hit.empty else None

        held = []
        for key, label, event_type in PRODUCTS:
            is_held = bool(row[f"has_{key}"])
            held.append(
                {
                    "key": key,
                    "label": label,
                    "held": is_held,
                    "date": since(event_type) if is_held else None,
                }
            )

        balances = self._enriched["term_balance"].dropna()
        balance = row["term_balance"]
        pct = None
        if pd.notna(balance) and len(balances):
            pct = round(float((balances <= balance).mean() * 100))

        premium = (
            row["motor_Annual_Premium"] if bool(row["has_motor_insurance"]) else None
        )
        holders = self._enriched.loc[
            self._enriched["has_motor_insurance"], "motor_Annual_Premium"
        ].dropna()

        return {
            "held": held,
            "count": int(row["products_held"]),
            "max": len(PRODUCTS),
            "balance": _num(balance, 0),
            "balance_percentile": pct,
            "premium": _num(premium, 0),
            "ref": {
                "p5": _num(balances.quantile(0.05), 0),
                "p25": _num(balances.quantile(0.25), 0),
                "median": _num(balances.median(), 0),
                "p75": _num(balances.quantile(0.75), 0),
                "p95": _num(balances.quantile(0.95), 0),
                "premium_median": _num(holders.median(), 0),
            },
        }

    def portfolio_products(self, dim: str = "age") -> dict:
        """Static portfolio view: independent of the selected customer."""
        if dim not in PORTFOLIO_DIMENSIONS:
            dim = "age"
        if dim in self._portfolio_product_cache:
            return self._portfolio_product_cache[dim]

        df = self._enriched
        group_col = {
            "age": "age_group",
            "job": "term_job",
            "education": "term_education",
            "marital": "term_marital",
        }[dim]

        rows = []
        for name, g in df.groupby(group_col, dropna=False, observed=True):
            holders = g.loc[g["has_motor_insurance"], "motor_Annual_Premium"].dropna()
            rows.append(
                {
                    "group": "Unknown" if pd.isna(name) else str(name),
                    "n": int(len(g)),
                    "low_n": bool(len(g) < MIN_GROUP_N),
                    "balance_mean": _num(g["term_balance"].mean(), 0),
                    "balance_median": _num(g["term_balance"].median(), 0),
                    "products_mean": _num(g["products_held"].mean(), 2),
                    "premium_n": int(len(holders)),
                    "premium_low_n": bool(len(holders) < MIN_PREMIUM_N),
                    "premium_mean": _num(holders.mean(), 0),
                    "premium_median": _num(holders.median(), 0),
                }
            )

        if dim == "age":
            order = {label: i for i, label in enumerate(AGE_LABELS)}
            rows.sort(key=lambda r: order.get(r["group"], 99))
        else:
            rows.sort(key=lambda r: -r["n"])

        total = len(df)
        penetration = [
            {
                "key": key,
                "label": label,
                "customers": int(df[f"has_{key}"].sum()),
                "pct": _num(df[f"has_{key}"].mean() * 100, 1),
            }
            for key, label, _ in PRODUCTS
        ]

        result = {
            "dimension": dim,
            "dimension_label": PORTFOLIO_DIMENSIONS[dim],
            "dimensions": [
                {"key": k, "label": v} for k, v in PORTFOLIO_DIMENSIONS.items()
            ],
            "min_group_n": MIN_GROUP_N,
            "rows": rows,
            "penetration": penetration,
            "kpis": {
                "customers": int(total),
                "products_mean": _num(df["products_held"].mean(), 2),
                "no_product_pct": _num((df["products_held"] == 0).mean() * 100, 1),
                "balance_mean": _num(df["term_balance"].mean(), 0),
                "balance_median": _num(df["term_balance"].median(), 0),
                "negative_balance": int((df["term_balance"] < 0).sum()),
                "motor_holders": int(df["has_motor_insurance"].sum()),
            },
        }
        self._portfolio_product_cache[dim] = result
        return result

    def customer_ids(self) -> list[str]:
        return sorted(
            self.main["synthetic_link_id"]
            .dropna()
            .unique()
            .tolist()
        )

    def snapshot_date(self):
        dates = self.main["nbc_score_date"].dropna()
        return dates.iloc[0] if not dates.empty else None

    def get_customer(self, cid: str) -> pd.Series | None:
        if cid not in self._main_by_id.index:
            return None

        row = self._main_by_id.loc[cid]
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        return row

    def get_interaction(self, cid: str) -> pd.Series | None:
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
            ["point_in_time", "nbc_date"],
            ascending=[True, True],
        )

    def _profile_rows(
        self,
        customer: pd.Series,
        requested_columns: list[str],
        prefix: str,
    ) -> list[dict]:
        """
        Build profile rows with resilient column resolution.

        The preferred contract is exact names such as term_age / motor_Age.
        If those names have harmless casing/punctuation differences, they are
        still resolved. Additional columns sharing the profile prefix are
        appended after the documented fields.
        """
        out: list[dict] = []
        seen: set[str] = set()
        columns = list(customer.index)

        def append_column(actual: str, requested: str | None = None) -> None:
            if actual in seen:
                return

            label_source = requested or actual
            value = customer[actual]
            out.append(
                {
                    "field": str(label_source),
                    "value": value,
                }
            )
            seen.add(actual)

        # Documented fields first.
        for requested in requested_columns:
            actual = _resolve_column(columns, requested)
            if actual is not None:
                append_column(actual, requested)

        # Then any additional source columns with the same prefix.
        prefix_lower = prefix.lower()
        for actual in columns:
            actual_str = str(actual)
            if actual in seen:
                continue
            if actual_str.lower().startswith(prefix_lower):
                append_column(actual)

        return out

    def get_term_profile(self, cid: str) -> list[dict]:
        customer = self.get_customer(cid)
        return (
            self._profile_rows(customer, TERM_PROFILE_COLS, "term_")
            if customer is not None
            else []
        )

    def get_insurance_profile(self, cid: str) -> list[dict]:
        customer = self.get_customer(cid)
        return (
            self._profile_rows(customer, INSURANCE_PROFILE_COLS, "motor_")
            if customer is not None
            else []
        )

    def portfolio_top3_by_point(self) -> dict:
        """
        Fixed portfolio view.

        For each historical point:
          1. count customers by NBC1
          2. retain the top three NBC1 states
          3. return a series suitable for a stacked bar chart

        This result is completely independent of the selected customer.
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
            int(point)
            for point in top3["point_in_time"].dropna().unique()
        )

        # Use P1...P18 on the x-axis. Dates remain available in hover text.
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

        state_order = (
            top3.groupby("NBC1")["customers"]
            .sum()
            .sort_values(ascending=False)
        )
        states = state_order.index.tolist()

        series: list[dict] = []
        for state in states:
            values: list[int] = []
            for point in points:
                match = top3.loc[
                    (top3["point_in_time"] == point)
                    & (top3["NBC1"] == state),
                    "customers",
                ]
                values.append(int(match.iloc[0]) if not match.empty else 0)

            series.append(
                {
                    "state": str(state),
                    "values": values,
                }
            )

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
            "point_dates": [point_dates[point] for point in points],
            "series": series,
            "top3_by_point": top3_lookup,
        }


@lru_cache(maxsize=1)
def get_store() -> DataStore:
    return DataStore()