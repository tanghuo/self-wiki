export default function WorkflowStatusLight({ state, label, className = '' }) {
  return <span className={`workflow-status-light ${className}`.trim()} data-state={state} role="img" aria-label={label} title={label} />;
}
