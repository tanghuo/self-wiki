import { useCallback, useLayoutEffect, useRef } from 'react';

function resize(node) {
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(180, Math.max(64, node.scrollHeight))}px`;
}

export default function useWorkbenchTextarea(text) {
  const element = useRef(null);
  const attach = useCallback(node => { element.current = node; resize(node); }, []);
  useLayoutEffect(() => { resize(element.current); }, [text]);
  return attach;
}
