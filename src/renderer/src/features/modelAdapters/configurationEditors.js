import ComfyuiConfiguration from './ComfyuiConfiguration.jsx';

// Provider-specific editors belong to the adapter layer, not the workflow editor.
export const configurationEditors = {
  comfyui: {
    Component: ComfyuiConfiguration,
    update(config, value) {
      return { ...config, adapterConfig: value, adapterInputs: value.promptMode === 'workflow' ? { images: 'list<image>' } : { prompt: 'text', images: 'list<image>' } };
    },
  },
};
