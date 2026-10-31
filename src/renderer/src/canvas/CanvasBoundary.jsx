import { Component } from "react";
import { Button } from "../ui/Button.jsx";

export default class CanvasBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <section className="wiki-canvas-error" role="alert">
      <h1>关系画布暂时无法显示</h1>
      <p>可以重新加载页面后再试，或返回内容库继续浏览。</p>
      <details><summary>错误信息</summary><pre>{String(this.state.error?.message || this.state.error)}</pre></details>
      <div className="wiki-actions">
        <Button variant="primary" type="submit" onClick={() => window.location.reload()}>重新加载页面</Button>
        <button onClick={this.props.onBack}>返回内容库</button>
      </div>
    </section>;
  }
}
