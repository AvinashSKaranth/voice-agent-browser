import type { Tool } from '../../core/types';

// ponytail: tracks only the last image *this tool* captured via the camera; it does not see images
// attached elsewhere in the conversation. Wire up a shared "last image" store if that's needed later.
let lastImage: string | null = null;

async function captureFromCamera(): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the sensor settle
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas 2D context unavailable');
    g.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

const describe_image: Tool = {
  spec: {
    name: 'describe_image',
    description: 'Describe or answer a question about an image: the last captured image, a fresh camera snapshot, or a provided data URL.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '"last", "camera", or a data:image/... URL' },
        question: { type: 'string', description: 'What to ask about the image; defaults to a general description' },
      },
      required: ['source'],
    },
  },
  spoken: 'Let me take a look',
  async run(args, ctx) {
    const provider = ctx.provider();
    if (!provider.supportsImages) return { ok: false, content: '', error: 'current model cannot see images' };

    const source = String(args.source ?? 'last');
    let dataUrl: string;
    try {
      if (source === 'camera') {
        dataUrl = await captureFromCamera();
        lastImage = dataUrl;
      } else if (source === 'last') {
        if (!lastImage) return { ok: false, content: '', error: 'No previous image available' };
        dataUrl = lastImage;
      } else if (source.startsWith('data:')) {
        dataUrl = source;
        lastImage = dataUrl;
      } else {
        return { ok: false, content: '', error: `Unrecognised image source: ${source}` };
      }
    } catch (e) {
      return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }

    const question = args.question ? String(args.question) : 'Describe this image.';
    const result = await provider.generate({
      messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image', dataUrl }] }],
      tools: [],
      signal: ctx.signal,
      onToken: () => {},
    });
    return { ok: true, content: result.text };
  },
};

export default describe_image;
