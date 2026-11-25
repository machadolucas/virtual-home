import * as THREE from "three";

/** WebXR's compositor owns the headset framebuffer. Render one aligned eye to an owned target. */
export function captureEye(gl: THREE.WebGLRenderer, scene: THREE.Scene, eye: THREE.PerspectiveCamera) {
  const width = 1024;
  const projection = eye.projectionMatrix.elements;
  const height = Math.max(256, Math.min(1536, Math.round(width * projection[0]! / projection[5]!)));
  const target = new THREE.WebGLRenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace });
  const previous = gl.getRenderTarget();
  const viewport = gl.getViewport(new THREE.Vector4()), scissor = gl.getScissor(new THREE.Vector4());
  const scissorTest = gl.getScissorTest(), enabled = gl.xr.enabled;
  const framebuffer = new Uint8Array(width * height * 4);
  try {
    gl.xr.enabled = false;
    gl.setRenderTarget(target);
    gl.setScissorTest(false);
    gl.render(scene, eye);
    gl.readRenderTargetPixels(target, 0, 0, width, height, framebuffer);
  } finally {
    gl.xr.enabled = enabled;
    gl.setRenderTarget(previous);
    gl.setViewport(viewport); gl.setScissor(scissor); gl.setScissorTest(scissorTest);
    target.dispose();
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not encode the headset image.");
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const start = (height - 1 - y) * width * 4;
    image.data.set(framebuffer.subarray(start, start + width * 4), y * width * 4);
  }
  context.putImageData(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Capture failed.")), "image/png"));
}
