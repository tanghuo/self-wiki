import VideoPlayer from "../../VideoPlayer.jsx";
import VideoAnalysisPanel from "./VideoAnalysisPanel.jsx";
import VideoMarkers from "./VideoMarkers.jsx";

/** Registered video detail media + analysis + markers block for ElementDetail. */
export default function VideoDetailBlocks({
  id, element, videoPlayer, revision, externalRevision, refresh,
  setSeekPosition, setVisualFrameRequest, visualMatchesRef,
  seekPosition, markerId, onOpen, setBusy, externalBusy, readOnly,
}) {
  return <>
    <VideoPlayer key={id} element={element} playerRef={videoPlayer} />
    <VideoAnalysisPanel
      key={`analysis-${id}`}
      videoId={id}
      revision={`${revision}:${externalRevision}`}
      onChanged={refresh}
      onSeek={setSeekPosition}
      onFindSimilar={(frameId) => {
        setVisualFrameRequest({ frameId });
        requestAnimationFrame(() => visualMatchesRef.current?.scrollIntoView({ block: "nearest" }));
      }}
      onBusyChange={setBusy}
      disabled={externalBusy}
      readOnly={readOnly}
    />
    <VideoMarkers
      videoId={id}
      playerRef={videoPlayer}
      initialMarkerId={markerId}
      initialPosition={seekPosition}
      revision={`${revision}:${externalRevision}`}
      onChanged={refresh}
      onOpen={onOpen}
      onBusyChange={setBusy}
      disabled={externalBusy}
      readOnly={readOnly}
    />
  </>;
}
