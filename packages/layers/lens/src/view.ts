// The magnified glass on the controller (#351), after the Lindholmen artwork's magnifier: the
// sample the table sends, drawn through a lens. The inner 70% stays exact; the rim compresses
// the picture inward with a slight colour fringe, a warm reflection along its top left and a
// soft vignette, so it reads as glass. WebGL where there is one, a plain round crop otherwise.

const VERTEX = 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);gl_Position=vec4(p,0.,1.);}';
const FRAGMENT = `precision mediump float;
varying vec2 uv;uniform sampler2D image;uniform float pinned;
void main(){
  vec2 p=uv*2.-1.;float r=length(p),edge=smoothstep(.7,1.,r);
  vec2 q=p*(1.-.28*edge*(1.-edge));
  vec3 color=texture2D(image,q*.5+.5).rgb;
  vec2 fringe=p*.0018*edge;
  color.r=texture2D(image,q*.5+.5+fringe).r;
  color.b=texture2D(image,q*.5+.5-fringe).b;
  float rim=smoothstep(.963,.982,r)*(1.-smoothstep(.987,1.,r));
  float reflection=pow(max(0.,dot(normalize(p+vec2(.0001)),normalize(vec2(-.55,-.8)))),10.);
  color*=1.-.16*edge;
  color+=vec3(.78,.71,.55)*rim*(.16+.55*reflection+.25*pinned);
  color+=vec3(.2,.18,.14)*edge*(1.-r)*reflection;
  float a=1.-smoothstep(.994,1.,r);
  gl_FragColor=vec4(color*a,a);
}`;

export class GlassView {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private texture: WebGLTexture | null = null;
  private pinnedAt: WebGLUniformLocation | null = null;
  private flat: CanvasRenderingContext2D | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    try {
      const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
      if (gl) this.setup(gl);
    } catch {
      this.gl = null;
    }
    if (!this.gl) this.flat = this.canvas.getContext('2d');
  }

  private setup(gl: WebGLRenderingContext): void {
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('lens shader');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.pinnedAt = gl.getUniformLocation(program, 'pinned');
    this.gl = gl;
  }

  /** Draws `picture` (square, the sample) through the glass at `size` device pixels across. */
  draw(picture: CanvasImageSource & { width: number; height: number }, size: number, pinned: boolean): void {
    if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
    const gl = this.gl;
    if (gl) {
      gl.viewport(0, 0, size, size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture as TexImageSource);
      gl.uniform1f(this.pinnedAt, pinned ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    const g = this.flat!;
    g.clearRect(0, 0, size, size);
    g.save();
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.clip();
    g.imageSmoothingQuality = 'high';
    g.drawImage(picture, 0, 0, size, size);
    g.restore();
  }
}
