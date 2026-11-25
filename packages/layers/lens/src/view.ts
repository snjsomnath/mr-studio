// The magnified glass on the controller (#351), after the Lindholmen artwork's magnifier: the
// sample the table sends, drawn through a lens. The inner 70% stays exact; the rim compresses
// the picture inward with a slight colour fringe, a warm reflection along its top left and a
// soft vignette, so it reads as glass. WebGL where there is one, a plain round crop otherwise.
// With `caustic` (#415), two slow rings of light sweep outward every 8 s, lighting only the
// lines under the glass (where the picture has contrast), as the old artwork glass did.

const VERTEX = 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);gl_Position=vec4(p,0.,1.);}';
const FRAGMENT = `precision mediump float;
varying vec2 uv;uniform sampler2D image;uniform float pinned;uniform float time;uniform float caustic;uniform vec2 texel;
float lum(vec2 at){return dot(texture2D(image,at).rgb,vec3(.299,.587,.114));}
void main(){
  vec2 p=uv*2.-1.;float r=length(p),edge=smoothstep(.7,1.,r);
  vec2 q=p*(1.-.28*edge*(1.-edge));
  vec3 color=texture2D(image,q*.5+.5).rgb;
  vec2 fringe=p*.0018*edge;
  color.r=texture2D(image,q*.5+.5+fringe).r;
  color.b=texture2D(image,q*.5+.5-fringe).b;
  float rim=smoothstep(.963,.982,r)*(1.-smoothstep(.987,1.,r));
  float reflection=pow(max(0.,dot(normalize(p+vec2(.0001)),normalize(vec2(-.55,-.8)))),10.);
  if(caustic>0.){
    vec2 at=q*.5+.5;
    float ink=abs(lum(at)*4.-lum(at+vec2(texel.x*2.,0.))-lum(at-vec2(texel.x*2.,0.))-lum(at+vec2(0.,texel.y*2.))-lum(at-vec2(0.,texel.y*2.)));
    ink=smoothstep(.04,.35,ink);
    float a=atan(p.y,p.x),light=0.;
    for(int k=0;k<2;k++){
      float ring=fract(time/8.+float(k)*.5)*1.25;
      float d=r-ring-.025*sin(a*5.+time*.7+float(k)*2.1)-.018*sin(a*9.-time*.5);
      light+=exp(-d*d/.0036)*(1.-ring/1.25);
    }
    float glint=clamp(ink*light*caustic,0.,1.);
    color=mix(color,vec3(1.,.74,.36),glint*.7)+vec3(.35,.26,.12)*glint;
  }
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
  private timeAt: WebGLUniformLocation | null = null;
  private causticAt: WebGLUniformLocation | null = null;
  private texelAt: WebGLUniformLocation | null = null;
  /** The picture last sent to the GPU, so a frame of the caustic light alone does not send it again. */
  private uploaded: unknown = null;
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
    this.timeAt = gl.getUniformLocation(program, 'time');
    this.causticAt = gl.getUniformLocation(program, 'caustic');
    this.texelAt = gl.getUniformLocation(program, 'texel');
    this.gl = gl;
  }

  /** Whether the glass can draw the caustic light (it needs WebGL). */
  get animates(): boolean {
    return this.gl !== null;
  }

  /**
   * Draws `picture` (square, the sample) through the glass at `size` device pixels across.
   * `caustic` is the caustic light's strength (0 off) and `time` its clock in seconds.
   */
  draw(picture: CanvasImageSource & { width: number; height: number }, size: number, pinned: boolean, caustic = 0, time = 0): void {
    if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
    const gl = this.gl;
    if (gl) {
      gl.viewport(0, 0, size, size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (this.uploaded !== picture) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture as TexImageSource);
        this.uploaded = picture;
      }
      gl.uniform1f(this.pinnedAt, pinned ? 1 : 0);
      gl.uniform1f(this.causticAt, caustic);
      gl.uniform1f(this.timeAt, time);
      gl.uniform2f(this.texelAt, 1 / Math.max(1, picture.width), 1 / Math.max(1, picture.height));
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
