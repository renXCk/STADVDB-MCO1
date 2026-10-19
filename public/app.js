const $ = (id) => document.getElementById(id);
const REGIONS = ['central Bohemia','east Bohemia','north Bohemia','north Moravia','Prague','south Bohemia','south Moravia','west Bohemia'];

for (let y = 1993; y <= 1998; y++) {
  $('year_from').add(new Option(y, y));
  $('year_to').add(new Option(y, y, false, y === 1998));
}
REGIONS.forEach((r) => $('region').add(new Option(r, r)));

async function checkHealth() {
  try {
    const h = await (await fetch('/api/health')).json();
    $('status').textContent = 'App running · database: ' + h.database;
  } catch { $('status').textContent = 'API not reachable'; }
}

checkHealth();

const demoChart = echarts.init(document.getElementById('echarts-demo'));

demoChart.setOption({
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category',
    data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    axisLabel: { color: '#b8b2aa' },
    axisLine: { lineStyle: { color: '#514d48' } }
  },
  yAxis: {
    type: 'value',
    axisLabel: { color: '#b8b2aa' },
    splitLine: { lineStyle: { color: '#34312e' } }
  },
  series: [{
    name: 'Transaction Amount',
    type: 'bar',
    data: [120, 180, 140, 220, 195, 260],
    itemStyle: {
      color: '#6bb2d1',
      borderRadius: [5, 5, 0, 0]
    },
    animationDuration: 1000
  }]
});


const demoMonthlyValues = [120, 180, 140, 220, 195, 260];


let selectedDemoQuarter = null;

function updateDemoTrend() {
  const level = $('level').value;

  $('rollup-btn').disabled = level === 'year';

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
  let labels;
  let values;

  if (level === 'year') {
    labels = ['1993 (Jan-Jun only)'];
    values = [demoMonthlyValues.reduce((a, b) => a + b, 0)];

  } else if (level === 'quarter') {
    labels = ['Q1', 'Q2'];
    values = [
      demoMonthlyValues.slice(0, 3).reduce((a, b) => a + b, 0),
      demoMonthlyValues.slice(3, 6).reduce((a, b) => a + b, 0)
    ];

  } else {
    const start = selectedDemoQuarter
      ? (selectedDemoQuarter - 1) * 3
      : 0;

    const end = selectedDemoQuarter ? start + 3 : 6;

    labels = months.slice(start, end);
    values = demoMonthlyValues.slice(start, end);
  }

  demoChart.setOption({
    xAxis: { data: labels },
    series: [{ data: values }]
  });
}

// Dropdown control
$('level').addEventListener('change', () => {
  selectedDemoQuarter = null;
  updateDemoTrend();
});

// Click-to-drill-down
demoChart.on('click', (params) => {
  if (params.componentType !== 'series') return;

  const level = $('level').value;

  if (level === 'year') {
    $('level').value = 'quarter';

  } else if (level === 'quarter') {
    selectedDemoQuarter = params.dataIndex + 1;
    $('level').value = 'month';

  } else {
    return;
  }

  updateDemoTrend();
});


$('rollup-btn').addEventListener('click', () => {
  const level = $('level');

  if (level.value === 'month') {
    level.value = 'quarter';
    selectedDemoQuarter = null;
  } else if (level.value === 'quarter') {
    level.value = 'year';
  }

  updateDemoTrend();
});


updateDemoTrend();


$('level').addEventListener('change', updateDemoTrend);
updateDemoTrend();



const operationChart = echarts.init(
  document.getElementById('operation-chart')
);

operationChart.setOption({
  tooltip: {
    trigger: 'item',
    formatter: '{b}: {c} transactions ({d}%)'
  },
  legend: {
    bottom: 0,
    textStyle: { color: '#b8b2aa' }
  },
  series: [{
    name: 'Transactions',
    type: 'pie',
    radius: ['45%', '70%'],
    center: ['50%', '43%'],
    label: { show: false },
    data: [
      { value: 420, name: 'Transfers' },
      { value: 280, name: 'Withdrawals' },
      { value: 180, name: 'Deposits' },
      { value: 120, name: 'Other' }
    ]
  }]
});

window.addEventListener('resize', () => operationChart.resize());


window.addEventListener('resize', () => demoChart.resize());


const panels = {
  transactions: 'transactions-panel',
  loans: 'loans-panel',
  'cross-fact': 'cross-fact-panel'
};

document.querySelectorAll('.tab-btn').forEach(button => {
  button.addEventListener('click', () => {
    const selectedTab = button.dataset.tab;

    // Highlight the selected navigation button
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === selectedTab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });

    // Display only the selected dashboard
    Object.entries(panels).forEach(([tab, panelId]) => {
      document.getElementById(panelId).hidden = tab !== selectedTab;
    });

    // Resize ECharts when returning to Transactions
    if (selectedTab === 'transactions') {
      requestAnimationFrame(() => {
        demoChart.resize();
        operationChart.resize();
      });
    }
  });
});