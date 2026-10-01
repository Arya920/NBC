// =============================================================
// NBC Command Center — front-end logic
// =============================================================

const state = {
    customers: [],
    currentId: null,
    currentPayload: null,
    portfolio: null,
    stateColors: {},
};

const PALETTE = [
    '#42d9d0', '#6aa6ff', '#a78bfa', '#f7c873',
    '#ff7c86', '#6fe0a9', '#8da3b8', '#dc8cff', '#7dd3fc',
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// -------------------------------------------------------------
// Startup
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    bindTabs();
    await loadMeta();
    await loadCustomers();
    await loadPortfolio();
    if (state.customers.length) {
        selectCustomer(state.customers[0]);
    }
});

// -------------------------------------------------------------
// Tabs
// -------------------------------------------------------------
function bindTabs() {
    $$('#main-tabs .tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            $$('#main-tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
            $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === target));
            if (target === 'history') {
                if (state.portfolio) {
                    renderPortfolio(state.portfolio);
                }
                window.dispatchEvent(new Event('resize'));
            }
        });
    });

    $$('#context-tabs .tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.subtab;
            $$('#context-tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
            $$('.sub-panel').forEach(p => p.classList.toggle('active', p.dataset.subpanel === target));
        });
    });
}

// -------------------------------------------------------------
// Meta + customer list
// -------------------------------------------------------------
async function loadMeta() {
    try {
        const r = await fetch('/api/meta');
        const data = await r.json();
        const el = $('#dataset-status');
        el.innerHTML = `
            <span class="chip">Snapshot · ${data.snapshot_date}</span>
            <span class="chip">Customers · ${data.customer_count.toLocaleString()}</span>
            <span class="chip">History rows · ${data.history_rows.toLocaleString()}</span>
        `;
    } catch (e) { console.error(e); }
}

async function loadCustomers() {
    const r = await fetch('/api/customers');
    const data = await r.json();
    state.customers = data.ids;

    const input = $('#customer-search');
    const list = $('#customer-list');

    const renderList = (filter = '') => {
        const q = filter.trim().toLowerCase();
        const items = q
            ? state.customers.filter(c => c.toLowerCase().includes(q))
            : state.customers;
        const show = items.slice(0, 200);
        list.innerHTML = show.map(c => `<li data-id="${c}">${c}</li>`).join('') ||
            '<li style="opacity:.6;cursor:default;">No match</li>';
    };

    input.addEventListener('focus', () => {
        renderList(input.value);
        list.classList.remove('hidden');
    });
    input.addEventListener('input', () => {
        renderList(input.value);
        list.classList.remove('hidden');
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const first = list.querySelector('li[data-id]');
            if (first) {
                selectCustomer(first.dataset.id);
                list.classList.add('hidden');
                input.blur();
            }
        }
        if (e.key === 'Escape') {
            list.classList.add('hidden');
            input.blur();
        }
    });

    list.addEventListener('click', (e) => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        selectCustomer(li.dataset.id);
        list.classList.add('hidden');
        input.blur();
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#customer-combobox')) {
            list.classList.add('hidden');
        }
    });

    input.value = state.customers[0] || '';
}

function selectCustomer(id) {
    state.currentId = id;
    $('#customer-search').value = id;
    fetchCustomer(id);
}

// -------------------------------------------------------------
// Customer payload
// -------------------------------------------------------------
async function fetchCustomer(id) {
    try {
        const r = await fetch(`/api/customer/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error('Customer not found');
        const data = await r.json();
        state.currentPayload = data;
        renderAll(data);
    } catch (e) {
        console.error(e);
    }
}

function renderAll(d) {
    renderHero(d.hero);
    renderNbc(d.nbc);
    renderContext(d.context);
    renderInteraction(d.interaction);
    renderDecisionSupport(d.predictions, d.signals);
    renderProfile('#term-profile', d.term_profile);
    renderProfile('#insurance-profile', d.insurance_profile);
    renderHistoryTab(d);
}

// -------------------------------------------------------------
// Hero
// -------------------------------------------------------------
function renderHero(h) {
    $('#hero-id').textContent = h.id;
    const chips = [
        `Score date · ${h.score_date}`,
        `Channel · ${h.channel}`,
        `Last action · ${h.last_action_date}`,
    ];
    $('#hero-chips').innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join('');
}

// -------------------------------------------------------------
// NBC cards
// -------------------------------------------------------------
function renderNbc(nbc) {
    $('#nbc1-value').textContent = nbc.nbc1;
    $('#nbc2-value').textContent = nbc.nbc2;
    $('#nbc3-value').textContent = nbc.nbc3;
}

// -------------------------------------------------------------
// Decision support
// -------------------------------------------------------------
function renderDecisionSupport(predictions, signals) {
    applyPrediction('#term-pill', '#term-affinity-text', '#term-affinity-bar', predictions.term);
    applyPrediction('#ins-pill', '#ins-affinity-text', '#ins-affinity-bar', predictions.insurance);
    renderSignals(signals);
}

function applyPrediction(pillSel, textSel, barSel, data) {
    const pill = $(pillSel);
    if (!pill || !data) return;

    pill.textContent = data.label;
    pill.className = 'pred-pill ' + (data.is_yes ? 'pred-yes' : 'pred-no');

    const textEl = $(textSel);
    const barEl = $(barSel);

    if (textEl) textEl.textContent = data.affinity_display;
    if (barEl) barEl.style.width = data.affinity_width + '%';
}

// -------------------------------------------------------------
// Context strip
// -------------------------------------------------------------
function renderContext(ctx) {
    $('#ctx-last-action').textContent = ctx.last_action;
    $('#ctx-channel').textContent = ctx.channel;
    $('#ctx-action-date').textContent = ctx.action_date;
}

function renderInteraction(interaction) {
    if (!interaction) {
        $('#interaction-date').textContent = 'Last interaction';
        $('#interaction-text').textContent = 'No interaction record was found for this customer.';
        return;
    }
    $('#interaction-date').textContent = `Last interaction · ${interaction.date}`;
    $('#interaction-text').textContent = interaction.text;
}

function renderHistoryInsight(ins) {
    if (!ins) {
        $('#history-insight').style.display = 'none';
        return;
    }
    $('#history-insight').style.display = '';
    $('#history-insight-text').textContent =
        `Most frequent NBC1: ${ins.dominant} · ${ins.dominant_count}/${ins.total} points · ${ins.distinct} distinct states`;
}

// -------------------------------------------------------------
// Signals
// -------------------------------------------------------------
function renderSignals(signals) {
    const html = signals.map(s => `
        <div class="signal-card">
            <div class="signal-label">${s.label}</div>
            <div class="signal-value">${s.value}</div>
        </div>
    `).join('');
    $('#signals-grid').innerHTML = html;
}

// -------------------------------------------------------------
// Profile tables
// -------------------------------------------------------------
function renderProfile(sel, rows) {
    const el = $(sel);
    if (!rows || !rows.length) {
        el.innerHTML = '<div style="padding:16px;color:#8da3b8;">No fields available for this customer.</div>';
        return;
    }
    el.innerHTML = `
        <table>
            <thead><tr><th>Field</th><th>Value</th></tr></thead>
            <tbody>
                ${rows.map(r => `<tr><td>${r.field}</td><td>${r.value}</td></tr>`).join('')}
            </tbody>
        </table>
    `;
}

// -------------------------------------------------------------
// History tab
// -------------------------------------------------------------
function renderHistoryTab(d) {
    const hist = d.history_insight;

    if (!hist) {
        $('#hs-points').textContent = '—';
        $('#hs-dominant').textContent = '—';
        $('#hs-latest').textContent = '—';

        if (typeof Plotly !== 'undefined') {
            Plotly.purge('chart-customer-distribution');
        }

        return;
    }

    $('#hs-points').textContent = hist.total;
    $('#hs-dominant').textContent = hist.dominant;
    $('#hs-latest').textContent = hist.latest;

    const uniqueStates = Array.from(new Set(hist.points.map(p => p.state)));
    state.stateColors = {};

    uniqueStates.forEach((s, i) => {
        state.stateColors[s] = PALETTE[i % PALETTE.length];
    });

    renderCustomerDistribution(hist);

    $('#hist-dominant').textContent = hist.dominant;
    $('#hist-readout').textContent =
        `${hist.dominant} appeared in ${hist.dominant_count} of ${hist.total} historical points. ` +
        `The sequence starts at ${hist.first} and the latest historical point is ${hist.latest}.`;

    $('#current-vs-history').textContent = hist.matches_current
        ? 'Current NBC1 matches the latest historical NBC1.'
        : 'Current NBC1 differs from the latest historical NBC1.';

    const tableHtml = `
        <table>
            <thead>
                <tr>
                    <th>Point</th>
                    <th>NBC date</th>
                    <th>NBC1</th>
                </tr>
            </thead>
            <tbody>
                ${hist.points.map(p => `
                    <tr>
                        <td>${p.point ?? '—'}</td>
                        <td>${p.date}</td>
                        <td>${escapeHtml(p.state)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    $('#history-table').innerHTML = tableHtml;

    // NOTE: the portfolio chart is intentionally NOT re-rendered here.
    // It is customer-independent, and this function runs on every single
    // customer selection — including while the History tab is hidden
    // (display:none). Calling Plotly.react() into a zero-width hidden
    // container is what was corrupting the chart; see renderPortfolio()
    // and the '#main-tabs .tab' click handler for the actual trigger.
}

function renderCustomerDistribution(hist) {
    const labels = hist.counts.map(c => c.state);
    const values = hist.counts.map(c => c.value);

    const colors = labels.map((label, index) => {
        if (!state.stateColors[label]) {
            state.stateColors[label] = PALETTE[index % PALETTE.length];
        }
        return state.stateColors[label];
    });

    const trace = {
        x: values,
        y: labels,
        orientation: 'h',
        marker: {
            color: colors,
            opacity: 0.88,
        },
        hovertemplate:
            '<b>%{y}</b><br>%{x} of 18 historical points<extra></extra>',
        type: 'bar',
    };

    const maxValue = Math.max(...values, 0);

    const layout = baseLayout({
        height: Math.max(
            250,
            Math.min(360, labels.length * 48 + 75)
        ),
        margin: {
            l: 205,
            r: 24,
            t: 10,
            b: 36,
        },
        xaxis: {
            title: null,
            showgrid: true,
            gridcolor: 'rgba(141,163,184,0.08)',
            zeroline: false,
            tickfont: { size: 10 },
            dtick: 1,
            range: [0, Math.max(3, maxValue + 1)],
        },
        yaxis: {
            title: null,
            showgrid: false,
            zeroline: false,
            automargin: true,
            autorange: 'reversed',
            tickfont: { size: 10 },
        },
        showlegend: false,
    });

    Plotly.react(
        'chart-customer-distribution',
        [trace],
        layout,
        {
            displayModeBar: false,
            responsive: true,
        }
    );
}

// -------------------------------------------------------------
// Portfolio context — fixed across all customers
// -------------------------------------------------------------
async function loadPortfolio() {
    try {
        const r = await fetch('/api/portfolio');

        if (!r.ok) {
            throw new Error(`Portfolio request failed: ${r.status}`);
        }

        const data = await r.json();
        state.portfolio = data;

        const historyPanel = $('[data-panel="history"]');

        if (
            historyPanel &&
            historyPanel.classList.contains('active')
        ) {
            renderPortfolio(data);
        }
    } catch (e) {
        console.error('Portfolio load failed:', e);
    }
}

function renderPortfolio(data) {
    const container = document.getElementById('chart-portfolio');

    const showError = () => {
        if (container) {
            container.innerHTML =
                '<div class="chart-empty-state">Portfolio composition could not be loaded.</div>';
        }
    };

    if (
        !data ||
        !Array.isArray(data.points) ||
        !Array.isArray(data.series) ||
        !data.points.length
    ) {
        console.error('renderPortfolio: malformed /api/portfolio payload', data);
        showError();
        return;
    }

    // Only plot into a container that actually has layout dimensions.
    // Plotly.react()/newPlot() on a display:none ancestor gets a 0x0 box;
    // with multi-trace stacked bars + customdata this throws mid-render
    // and leaves the div in a half-initialized state that every later
    // Plotly.react() call on the same node keeps throwing on. Bail out
    // here and let the caller retry once the tab is actually visible.
    if (!container || container.offsetParent === null) {
        return;
    }

    const dates = data.point_dates || [];
    const labels = dates.length ? dates : data.points.map(point => `P${point}`);

    const portfolioColors = [
        '#42d9d0',
        '#6aa6ff',
        '#a78bfa',
        '#f7c873',
        '#ff7c86',
        '#6fe0a9',
        '#8da3b7',
        '#dc8cff',
        '#7dd3fc',
    ];

    const traces = data.series.map((series, index) => ({
        x: labels,
        y: series.values,
        name: series.state,
        type: 'bar',

        marker: {
            color: portfolioColors[
                index % portfolioColors.length
            ],
        },

        customdata: series.values.map(
            (value, pointIndex) => [
                data.points[pointIndex],
                dates[pointIndex] || '—',
                series.state,
                value,
            ]
        ),

        hovertemplate:
            '<b>%{customdata[2]}</b><br>' +
            'Point %{customdata[0]} · %{customdata[1]}<br>' +
            '%{customdata[3]:,} customers<extra></extra>',
    }));

    const layout = baseLayout({
        height: 430,

        barmode: 'stack',

        bargap: 0.28,

        margin: {
            l: 72,
            r: 28,
            t: 66,
            b: 54,
        },

        legend: {
            orientation: 'h',
            yanchor: 'bottom',
            y: 1.02,
            xanchor: 'left',
            x: 0,
            font: {
                size: 10,
                color: '#a8bbce',
            },
        },

        xaxis: {
            title: null,
            type: 'category',
            categoryorder: 'array',
            categoryarray: labels,
            showgrid: false,
            zeroline: false,
            tickmode: 'array',
            tickvals: labels,
            tickangle: -45,
            ticktext: labels,
            tickfont: {
                size: 10,
                color: '#8da3b8',
            },
        },

        yaxis: {
            title: {
                text: 'Number of customers',
                standoff: 12,
                font: {
                    size: 10,
                    color: '#8da3b8',
                },
            },
            rangemode: 'tozero',
            showgrid: true,
            gridcolor: 'rgba(141,163,184,0.08)',
            zeroline: false,
            tickfont: {
                size: 10,
                color: '#8da3b8',
            },
        },

        hovermode: 'closest',
    });

    try {
        // Purge first: if an earlier attempt on this same div threw
        // (e.g. the old hidden-container render), Plotly can be left
        // with inconsistent internal state that makes every subsequent
        // Plotly.react() on that node fail too. Purge guarantees a
        // clean slate before every (re)draw.
        Plotly.purge(container);
        Plotly.newPlot(
            container,
            traces,
            layout,
            {
                displayModeBar: false,
                responsive: true,
            }
        );
    } catch (err) {
        console.error('renderPortfolio: Plotly failed to render', err);
        showError();
    }
}

// -------------------------------------------------------------
// Plotly helpers
// -------------------------------------------------------------
function baseLayout(overrides = {}) {
    return Object.assign({
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#a8bbce', family: 'DM Sans, sans-serif' },
        hoverlabel: { bgcolor: '#102239', bordercolor: '#28445d', font_size: 11 },
    }, overrides);
}

window.addEventListener('resize', () => {
    ['chart-customer-distribution', 'chart-portfolio'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.data) Plotly.Plots.resize(el);
    });
});