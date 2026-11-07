// User-facing alerts describe the pending decision. Internal identifiers stay in
// TabPilot, where the user reviews the actual request and responds.
export function taskRequestAlert(record, request) {
    const detail = request.detail?.trim();
    const parts = [request.question.trim().slice(0,900)];
    if(detail) parts.push(detail.slice(0,1400));
    else if(record.tabTitle) parts.push('Task tab: '+record.tabTitle.slice(0,180));
    parts.push('Open TabPilot to review or respond in the browser.');
    return {subject:request.kind==='approval'?'TabPilot needs your permission':'TabPilot needs your input',message:parts.join('\n\n')};
}
