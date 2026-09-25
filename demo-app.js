const ui = {
  connection: document.querySelector('#connection'),
  connectionText: document.querySelector('#connectionText'),
  taskForm: document.querySelector('#taskForm'),
  taskInput: document.querySelector('#taskInput'),
  runButton: document.querySelector('#runButton'),
  runStatus: document.querySelector('#runStatus'),
  decisionCard: document.querySelector('#decisionCard'),
  decisionType: document.querySelector('#decisionType'),
  decisionAction: document.querySelector('#decisionAction'),
  matchValue: document.querySelector('#matchValue'),
  riskValue: document.querySelector('#riskValue'),
  samplePage: document.querySelector('#samplePage'),
  nextButton: document.querySelector('#nextButton'),
  pageStatus: document.querySelector('#pageStatus')
};

const demoTask = 'Click the Next button once on this local demo page.';
ui.taskInput.value = demoTask;

ui.nextButton.addEventListener('click', () => {
  ui.nextButton.disabled = true;
  ui.nextButton.textContent = 'Done';
  ui.pageStatus.textContent = 'Demo complete. Jev selected the local button; no data was sent from this page.';
  ui.pageStatus.classList.add('complete');
});

ui.taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const task = ui.taskInput.value.trim();
  if (!task) return;

  // Each run must inspect a fresh local page state. Without this reset the
  // previous successful run leaves Next disabled, so Jev correctly has no
  // available control to choose on the next run.
  ui.nextButton.disabled = false;
  ui.nextButton.textContent = 'Next';
  ui.pageStatus.textContent = 'Waiting for Jev’s decision.';
  ui.pageStatus.classList.remove('complete');

  ui.runButton.disabled = true;
  ui.decisionCard.hidden = true;
  ui.runStatus.className = 'run-status';
  ui.runStatus.textContent = 'Sending the task and local demo page text to Jev…';
  try {
    const response = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        page: { title: 'TabPilot local demo page', url: `${location.origin}/demo-app` },
        pageText: ui.samplePage.innerText.slice(0, 10000),
        controls: [describeButton(ui.nextButton)],
        history: []
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Jev request failed (${response.status}).`);

    ui.decisionCard.hidden = false;
    ui.decisionType.textContent = result.pageType || 'other';
    ui.matchValue.textContent = `${Math.round((result.matchProbability || 0) * 100)}%`;
    ui.riskValue.textContent = `${Math.round((result.riskProbability || 0) * 100)}%`;
    ui.decisionAction.textContent = describeAction(result.action);

    const selectedNext = result.action?.kind === 'click'
      && result.action?.control?.label === ui.nextButton.textContent.trim()
      && !ui.nextButton.disabled;
    const safeToRun = result.requiresReview === false
      && result.matchProbability >= 0.8
      && result.riskProbability < 0.2;

    if (selectedNext && safeToRun) {
      ui.runStatus.textContent = 'Jev chose Next with high task match and low risk. Performing that local click…';
      ui.nextButton.click();
      ui.runStatus.classList.add('success');
      ui.runStatus.textContent = 'Complete — Jev chose Next and the local page changed to Done.';
    } else {
      ui.runStatus.classList.add('error');
      ui.runStatus.textContent = result.requiresReview
        ? 'Jev requested review, so the page was left unchanged.'
        : 'No page action was performed: Jev did not return the safe Next-button decision.';
    }
  } catch (error) {
    ui.runStatus.classList.add('error');
    ui.runStatus.textContent = error.message || 'The Jev request failed.';
  } finally {
    ui.runButton.disabled = false;
  }
});

function describeButton(button) {
  const rect = button.getBoundingClientRect();
  return {
    tag: button.tagName.toLowerCase(),
    role: 'button',
    kind: 'button',
    label: button.textContent.trim(),
    type: button.type,
    disabled: button.disabled,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  };
}

function describeAction(action) {
  if (!action) return 'No action returned';
  if (action.kind === 'click') return `Click “${action.control?.label || 'button'}”`;
  if (action.kind === 'done') return 'Task complete';
  if (action.kind === 'ask') return 'Ask the user';
  return `No demo action (${action.kind})`;
}

async function checkBridge() {
  try {
    const response = await fetch('/health');
    const health = await response.json();
    const online = response.ok && health.ok && health.configured;
    ui.connection.classList.toggle('online', online);
    ui.connection.classList.toggle('offline', !online);
    ui.connectionText.textContent = online ? `${health.model} ready` : 'Bridge needs setup';
  } catch {
    ui.connection.classList.add('offline');
    ui.connectionText.textContent = 'Bridge unavailable';
  }
}

checkBridge();
