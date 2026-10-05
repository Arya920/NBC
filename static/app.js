// =============================================================
// NBC Command Center — frontend logic
// =============================================================

const state = {
    customers: [],
    currentId: null,
    currentPayload: null,
    portfolio: null,
    workspace: 'service',
    servicePage: 'customer',
    customerRequestSeq: 0,
};

const PALETTE = [
    '#42d9d0',
    '#6aa6ff',
    '#a78bfa',
    '#f7c873',
    '#ff7c86',
    '#6fe0a9',
    '#8da3b8',
    '#dc8cff',
    '#7dd3fc',
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', init);

async function init() {
    bindNavigation();
    setWorkspace('service');
    setServicePage('customer');

    await loadMeta();
    await loadCustomers();
    await loadPortfolio();

    if (state.customers.length > 0) {
        await selectCustomer(state.customers[0]);
    } else {
        showCustomerEmpty('No customers are available.');
    }
}


// -------------------------------------------------------------
// Navigation
// -------------------------------------------------------------

function bindNavigation() {
    $$('#main-tabs .primary-nav-link').forEach((button) => {
        button.addEventListener('click', () => {
            setWorkspace(button.dataset.workspace);
        });
    });

    $('#open-portfolio')?.addEventListener('click', () => {
        setServicePage('portfolio');
    });

    $('#back-to-customer')?.addEventListener('click', () => {
        setServicePage('customer');
    });
}

function setWorkspace(target) {
    state.workspace = target;

    $$('#main-tabs .primary-nav-link').forEach((button) => {
        button.classList.toggle(
            'active',
            button.dataset.workspace === target
        );
    });

    $$('[data-workspace-panel]').forEach((panel) => {
        panel.classList.toggle(
            'active',
            panel.dataset.workspacePanel === target
        );
    });

    updateCustomerScopeVisibility();

    if (target === 'service') {
        setServicePage(state.servicePage);
    }
}

function setServicePage(target) {
    state.servicePage = target;

    $$('[data-service-page]').forEach((page) => {
        page.classList.toggle(
            'active',
            page.dataset.servicePage === target
        );
    });

    updateCustomerScopeVisibility();

    requestAnimationFrame(() => {
        if (target === 'portfolio') {
            renderPortfolio(state.portfolio);
        } else if (target === 'customer') {
            renderCurrentCustomerHistory();
        }

        resizeVisibleCharts();
    });
}

function updateCustomerScopeVisibility() {
    const show = state.workspace === 'service' && state.servicePage === 'customer';

    $('#customer-navigation-scope')?.classList.toggle('scope-hidden', !show);
    $('#customer-hero')?.classList.toggle('scope-hidden', !show);
}


// -------------------------------------------------------------
// Metadata / customers
// -------------------------------------------------------------

async function loadMeta() {
    try {
        const response = await fetch('/api/meta', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Meta request failed: ${response.status}`);

        const data = await response.json();

        const el = $('#dataset-status');
        if (!el) return;

        el.innerHTML = `
            <span class="status-chip">Snapshot · ${escapeHtml(data.snapshot_date)}</span>
            <span class="status-chip">Customers · ${Number(data.customer_count || 0).toLocaleString()}</span>
            <span class="status-chip">History rows · ${Number(data.history_rows || 0).toLocaleString()}</span>
        `;
    } catch (error) {
        console.error('Meta load failed:', error);
        setStatusMessage('Dataset status unavailable');
    }
}

async function loadCustomers() {
    try {
        const response = await fetch('/api/customers', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Customer request failed: ${response.status}`);

        const data = await response.json();
        state.customers = Array.isArray(data.ids)
            ? data.ids.map(String)
            : [];

        const input = $('#customer-search');
        const list = $('#customer-list');
        if (!input || !list) return;

        const renderList = (filter = '') => {
            const query = filter.trim().toLowerCase();

            const items = query
                ? state.customers.filter((id) => id.toLowerCase().includes(query))
                : state.customers;

            const visibleItems = items.slice(0, 200);

            list.innerHTML = visibleItems.length
                ? visibleItems
                    .map(
                        (id) =>
                            `<li data-id="${escapeHtml(id)}">${escapeHtml(id)}</li>`
                    )
                    .join('')
                : '<li class="no-match">No customer found</li>';
        };

        input.addEventListener('focus', () => {
            renderList(input.value);
            list.classList.remove('hidden');
        });

        input.addEventListener('input', () => {
            renderList(input.value);
            list.classList.remove('hidden');
        });

        input.addEventListener('keydown', async (event) => {
            if (event.key === 'Enter') {
                const first = list.querySelector('li[data-id]');
                if (!first) return;

                list.classList.add('hidden');
                input.blur();
                await selectCustomer(first.dataset.id);
            }

            if (event.key === 'Escape') {
                list.classList.add('hidden');
                input.blur();
            }
        });

        list.addEventListener('click', async (event) => {
            const item = event.target.closest('li[data-id]');
            if (!item) return;

            list.classList.add('hidden');
            input.blur();
            await selectCustomer(item.dataset.id);
        });

        document.addEventListener('click', (event) => {
            if (!event.target.closest('#customer-combobox')) {
                list.classList.add('hidden');
            }
        });

        input.value = state.customers[0] || '';
    } catch (error) {
        console.error('Customer list load failed:', error);
        showCustomerEmpty('Customer list could not be loaded.');
    }
}

async function selectCustomer(id) {
    const customerId = String(id || '').trim();
    if (!customerId) return;

    state.currentId = customerId;

    const input = $('#customer-search');
    if (input) input.value = customerId;

    // Clear the previous chart before loading the new customer's data.
    clearCustomerHistoryChart();
    setHistoryLoading();

    const requestSeq = ++state.customerRequestSeq;

    try {
        const response = await fetch(
            `/api/customer/${encodeURIComponent(customerId)}`,
            { cache: 'no-store' }
        );

        if (!response.ok) {
            throw new Error(`Customer request failed: ${response.status}`);
        }

        const data = await response.json();

        // Ignore a slower response from an older selection.
        if (requestSeq !== state.customerRequestSeq) {
            return;
        }

        if (state.currentId !== customerId) {
            return;
        }

        state.currentPayload = data;
        renderCustomer(data);
    } catch (error) {
        if (requestSeq !== state.customerRequestSeq) return;

        console.error('Customer load failed:', error);
        showCustomerEmpty('Customer data could not be loaded.');
    }
}


// -------------------------------------------------------------
// Customer rendering
// -------------------------------------------------------------

function renderCustomer(data) {
    renderHero(data.hero);
    renderNbc(data.nbc);
    renderActivity(data.activity, data.interaction);

    renderProfileSummary(
        '#term-profile-summary',
        data.term_profile,
        6,
        'Term deposit profile unavailable'
    );
    renderFullProfile('#term-profile-full', data.term_profile);

    renderProfileSummary(
        '#insurance-profile-summary',
        data.insurance_profile,
        6,
        'Insurance profile unavailable'
    );
    renderFullProfile('#insurance-profile-full', data.insurance_profile);

    renderHistory(data.history);
}

function renderHero(hero) {
    setText('#hero-id', hero?.id);
    setText('#hero-score-date', hero?.score_date);
    setText('#hero-channel', hero?.channel);
    setText('#hero-last-action-date', hero?.last_action_date);
}

function renderNbc(nbc) {
    setText('#nbc1-value', nbc?.nbc1);
    setText('#nbc2-value', nbc?.nbc2);
    setText('#nbc3-value', nbc?.nbc3);
}

function renderActivity(activity, interaction) {
    setText('#ctx-last-action', activity?.last_action);
    setText('#ctx-channel', activity?.channel);
    setText('#ctx-action-date', activity?.action_date);

    if (!interaction) {
        setText('#interaction-date', 'No interaction date');
        setText(
            '#interaction-text',
            'No interaction record was found for this customer.'
        );
        return;
    }

    setText('#interaction-date', interaction.date);
    setText('#interaction-text', interaction.text);
}

function renderProfileSummary(selector, rows, limit, emptyText) {
    const container = $(selector);
    if (!container) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        container.innerHTML = `
            <div class="profile-empty-inline">
                <span>${escapeHtml(emptyText)}</span>
            </div>
        `;
        return;
    }

    const selected = rows.slice(0, limit);

    container.innerHTML = selected
        .map(
            (row) => `
                <div class="profile-item">
                    <span>${escapeHtml(row.field)}</span>
                    <strong>${escapeHtml(row.value)}</strong>
                </div>
            `
        )
        .join('');
}

function renderFullProfile(selector, rows) {
    const container = $(selector);
    if (!container) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Field</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody>
                ${rows
                    .map(
                        (row) => `
                            <tr>
                                <td>${escapeHtml(row.field)}</td>
                                <td>${escapeHtml(row.value)}</td>
                            </tr>
                        `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
}


// -------------------------------------------------------------
// Customer history
// -------------------------------------------------------------

function setHistoryLoading() {
    setText('#hs-points', 'Loading…');
    setText('#hs-dominant', 'Loading…');
    setText('#hs-latest', 'Loading…');
    setText('#hist-dominant', 'Loading…');
    setText('#hist-readout', 'Loading customer history…');
    setText('#current-vs-history', 'Loading…');

    const table = $('#history-table');
    if (table) table.innerHTML = '';

    $('#customer-chart-empty')?.classList.add('hidden');
}

function renderHistory(history) {
    const chartEmpty = $('#customer-chart-empty');

    if (!history) {
        setText('#hs-points', '0');
        setText('#hs-dominant', '—');
        setText('#hs-latest', '—');
        setText('#hist-dominant', 'No history');
        setText('#hist-readout', 'No historical NBC1 records are available.');
        setText('#current-vs-history', 'No comparison is available.');
        $('#history-table').innerHTML = '';
        showChartEmpty(chartEmpty, true);
        clearCustomerHistoryChart();
        return;
    }

    setText('#history-subtitle', `${history.total} historical points for ${state.currentId}`);
    setText('#hs-points', history.total);
    setText('#hs-dominant', history.dominant);
    setText('#hs-latest', history.latest);
    setText('#hist-dominant', history.dominant);

    setText(
        '#hist-readout',
        `${history.dominant} appeared in ${history.dominant_count} of ${history.total} historical points.`
    );

    setText(
        '#current-vs-history',
        history.matches_current
            ? 'Current NBC1 matches the latest historical NBC1.'
            : 'Current NBC1 differs from the latest historical NBC1.'
    );

    renderHistoryTable(history.points);
    showChartEmpty(chartEmpty, false);

    requestAnimationFrame(() => {
        renderCustomerDistribution(history);
    });
}

function renderCurrentCustomerHistory() {
    if (!state.currentPayload?.history) {
        return;
    }

    requestAnimationFrame(() => {
        renderCustomerDistribution(state.currentPayload.history);
    });
}

function renderHistoryTable(points) {
    const container = $('#history-table');
    if (!container) return;

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Point</th>
                    <th>NBC date</th>
                    <th>NBC1</th>
                </tr>
            </thead>
            <tbody>
                ${(points || [])
                    .map(
                        (point) => `
                            <tr>
                                <td>${escapeHtml(point.point)}</td>
                                <td>${escapeHtml(point.date)}</td>
                                <td>${escapeHtml(point.state)}</td>
                            </tr>
                        `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
}

function renderCustomerDistribution(history) {
    if (
        state.workspace !== 'service' ||
        state.servicePage !== 'customer' ||
        !history ||
        !Array.isArray(history.counts)
    ) {
        return;
    }

    const container = $('#chart-customer-distribution');
    if (!container || typeof Plotly === 'undefined') {
        return;
    }

    const labels = history.counts.map((item) => item.state);
    const values = history.counts.map((item) => Number(item.value || 0));

    if (!labels.length) {
        clearCustomerHistoryChart();
        return;
    }

    const traces = [
        {
            type: 'bar',
            orientation: 'h',
            x: values,
            y: labels,
            marker: {
                color: labels.map((_, index) => PALETTE[index % PALETTE.length]),
                opacity: 0.9,
            },
            hovertemplate: '<b>%{y}</b><br>%{x} of historical points<extra></extra>',
        },
    ];

    const maxValue = Math.max(...values, 1);

    const layout = chartBaseLayout({
        height: Math.max(320, Math.min(420, labels.length * 64 + 120)),
        margin: { l: 210, r: 30, t: 16, b: 50 },
        xaxis: {
            title: null,
            range: [0, maxValue + 1],
            dtick: 1,
            showgrid: true,
            gridcolor: 'rgba(141,163,184,0.08)',
            zeroline: false,
            tickfont: { size: 10, color: '#8da3b8' },
        },
        yaxis: {
            title: null,
            showgrid: false,
            zeroline: false,
            automargin: true,
            autorange: 'reversed',
            tickfont: { size: 11, color: '#b9cad9' },
        },
        showlegend: false,
    });

    try {
        Plotly.react(container, traces, layout, {
            displayModeBar: false,
            responsive: true,
        });
    } catch (error) {
        console.error('Customer history chart failed:', error);
    }
}

function clearCustomerHistoryChart() {
    const container = $('#chart-customer-distribution');
    if (!container || typeof Plotly === 'undefined') return;

    try {
        Plotly.purge(container);
    } catch (error) {
        console.warn('Could not clear customer history chart:', error);
    }
}


// -------------------------------------------------------------
// Portfolio
// -------------------------------------------------------------

async function loadPortfolio() {
    try {
        const response = await fetch('/api/portfolio', { cache: 'no-store' });

        if (!response.ok) {
            throw new Error(`Portfolio request failed: ${response.status}`);
        }

        state.portfolio = await response.json();

        if (state.workspace === 'service' && state.servicePage === 'portfolio') {
            requestAnimationFrame(() => renderPortfolio(state.portfolio));
        }
    } catch (error) {
        console.error('Portfolio load failed:', error);
        showPortfolioError();
    }
}

function renderPortfolio(data) {
    if (
        state.workspace !== 'service' ||
        state.servicePage !== 'portfolio'
    ) {
        return;
    }

    const container = $('#chart-portfolio');
    if (!container || typeof Plotly === 'undefined') {
        return;
    }

    if (
        !data ||
        !Array.isArray(data.points) ||
        !Array.isArray(data.series) ||
        !data.points.length
    ) {
        showPortfolioError();
        return;
    }

    const xLabels = data.points.map((point) => `P${point}`);
    const dates = Array.isArray(data.point_dates) ? data.point_dates : [];

    const colors = [
        '#42d9d0',
        '#6aa6ff',
        '#a78bfa',
        '#f7c873',
        '#ff7c86',
        '#6fe0a9',
    ];

    const traces = data.series.map((series, index) => ({
        type: 'bar',
        name: series.state,
        x: xLabels,
        y: series.values,
        marker: {
            color: colors[index % colors.length],
        },
        customdata: series.values.map((value, pointIndex) => [
            xLabels[pointIndex],
            dates[pointIndex] || '—',
            value,
        ]),
        hovertemplate:
            '<b>%{fullData.name}</b><br>' +
            '%{customdata[0]} · %{customdata[1]}<br>' +
            '%{customdata[2]:,} customers<extra></extra>',
    }));

    const layout = chartBaseLayout({
        height: 520,
        barmode: 'stack',
        bargap: 0.26,
        margin: { l: 70, r: 30, t: 70, b: 70 },
        legend: {
            orientation: 'h',
            yanchor: 'bottom',
            y: 1.02,
            xanchor: 'left',
            x: 0,
            font: {
                size: 10,
                color: '#a9bccd',
            },
        },
        xaxis: {
            title: {
                text: 'Historical point',
                font: { size: 11, color: '#8da3b8' },
            },
            type: 'category',
            showgrid: false,
            zeroline: false,
            tickfont: { size: 10, color: '#8da3b8' },
            tickmode: 'array',
            tickvals: xLabels,
            ticktext: xLabels,
        },
        yaxis: {
            title: {
                text: 'Number of customers',
                standoff: 12,
                font: { size: 11, color: '#8da3b8' },
            },
            rangemode: 'tozero',
            showgrid: true,
            gridcolor: 'rgba(141,163,184,0.08)',
            zeroline: false,
            tickfont: { size: 10, color: '#8da3b8' },
        },
        hovermode: 'closest',
    });

    try {
        Plotly.react(container, traces, layout, {
            displayModeBar: false,
            responsive: true,
        });

        showChartEmpty($('#portfolio-chart-empty'), false);
    } catch (error) {
        console.error('Portfolio chart failed:', error);
        showPortfolioError();
    }
}

function showPortfolioError() {
    showChartEmpty($('#portfolio-chart-empty'), true);

    const container = $('#chart-portfolio');
    if (container && typeof Plotly !== 'undefined') {
        try {
            Plotly.purge(container);
        } catch (error) {
            console.warn('Could not clear portfolio chart:', error);
        }
    }
}


// -------------------------------------------------------------
// Chart helpers
// -------------------------------------------------------------

function chartBaseLayout(overrides = {}) {
    return Object.assign(
        {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: {
                family: 'DM Sans, sans-serif',
                color: '#a8bbce',
            },
            hoverlabel: {
                bgcolor: '#102239',
                bordercolor: '#28445d',
                font_size: 11,
            },
        },
        overrides
    );
}

function resizeVisibleCharts() {
    if (typeof Plotly === 'undefined') return;

    ['chart-customer-distribution', 'chart-portfolio'].forEach((id) => {
        const element = document.getElementById(id);

        if (!element || !element.data) return;

        const visible =
            element.offsetWidth > 0 &&
            element.offsetHeight > 0;

        if (!visible) return;

        try {
            Plotly.Plots.resize(element);
        } catch (error) {
            console.warn(`Could not resize ${id}:`, error);
        }
    });
}

window.addEventListener('resize', () => {
    requestAnimationFrame(resizeVisibleCharts);
});


// -------------------------------------------------------------
// UI helpers
// -------------------------------------------------------------

function showCustomerEmpty(message) {
    setText('#hero-id', '—');
    setText('#hero-score-date', '—');
    setText('#hero-channel', '—');
    setText('#hero-last-action-date', '—');
    setText('#nbc1-value', '—');
    setText('#nbc2-value', '—');
    setText('#nbc3-value', '—');
    setText('#ctx-last-action', message);
    setText('#interaction-text', '—');

    clearCustomerHistoryChart();
}

function setStatusMessage(message) {
    const el = $('#dataset-status');
    if (el) {
        el.innerHTML = `<span class="status-chip">${escapeHtml(message)}</span>`;
    }
}

function setText(selector, value) {
    const element = $(selector);
    if (!element) return;

    const text = value === null || value === undefined || value === ''
        ? '—'
        : String(value);

    element.textContent = text;
}

function showChartEmpty(element, show) {
    if (!element) return;
    element.classList.toggle('hidden', !show);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}