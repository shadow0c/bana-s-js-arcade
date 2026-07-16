import * as THREE from 'three';

export interface ReflectiveFloorOptions {
  /** Zeminin bir kenar uzunluğu (kare düzlem) */
  size: number;
  /** Zeminin kendi (kum/toprak) dokusu — yansımayla harmanlanır */
  diffuseMap: THREE.Texture;
  /** Dokunun tekrar sayısı (floorTex.repeat ile aynı olmalı) */
  repeat: { x: number; y: number };
  textureWidth?: number;
  textureHeight?: number;
  multisample?: number;
  /** Yansımaya uygulanacak renk tonu (örn. hafif sıcak/soğuk ton) */
  tintColor?: number;
  /** Tepeden bakışta (dik açı) taban yansıtıcılık oranı */
  baseReflectivity?: number;
  clipBias?: number;
}

/**
 * Gerçek zamanlı, fiziksel olarak daha doğru düzlemsel (planar) zemin yansıması.
 *
 * Sahneyi ayna kamerasıyla ayrı bir render-target'a çizer, ardından bu yansımayı
 * zeminin kendi difüz dokusuyla Fresnel-Schlick yaklaşımına göre harmanlar:
 * tepeden bakılınca (dik açı) yansıma neredeyse görünmez ve kum dokusu hakimdir,
 * ufuğa/kameraya sıyırma açısıyla bakılınca yansıtıcılık belirgin şekilde artar —
 * ıslak/sıkışmış toprak zeminlerde gözlemlenen gerçek fiziksel davranış budur.
 */
export class PhysicalReflectiveFloor extends THREE.Mesh {
  // THREE.Mesh'ten miras kalan alanları TS'nin çıkarım kapsamında tuttuğumuzu
  // açıkça bildir — bazı üretim TS/three sürüm kombinasyonlarında generic'siz
  // extends kullanımı bu alanları "does not exist" olarak raporlayabiliyor.
  declare material: THREE.ShaderMaterial;
  declare geometry: THREE.BufferGeometry;
  declare matrixWorld: THREE.Matrix4;
  declare visible: boolean;

  private renderTarget: THREE.WebGLRenderTarget;
  private reflectionCameras = new WeakMap<THREE.Camera, THREE.PerspectiveCamera>();
  private clipBias: number;

  // Frame başına GC baskısını azaltmak için önceden ayrılmış geçici nesneler
  private _reflectorWorldPosition = new THREE.Vector3();
  private _cameraWorldPosition = new THREE.Vector3();
  private _rotationMatrix = new THREE.Matrix4();
  private _lookAtPosition = new THREE.Vector3();
  private _target = new THREE.Vector3();
  private _view = new THREE.Vector3();
  private _normal = new THREE.Vector3();
  private _reflectorPlane = new THREE.Plane();
  private _clipPlane = new THREE.Vector4();
  private _q = new THREE.Vector4();

  constructor(opts: ReflectiveFloorOptions) {
    const geometry = new THREE.PlaneGeometry(opts.size, opts.size);
    const textureWidth = opts.textureWidth ?? 512;
    const textureHeight = opts.textureHeight ?? 512;
    const renderTarget = new THREE.WebGLRenderTarget(textureWidth, textureHeight, {
      samples: opts.multisample ?? 4,
      type: THREE.HalfFloatType,
    });

    const material = new THREE.ShaderMaterial({
      name: 'PhysicalReflectiveFloorMaterial',
      uniforms: {
        tReflection: { value: renderTarget.texture },
        tDiffuse: { value: opts.diffuseMap },
        textureMatrix: { value: new THREE.Matrix4() },
        diffuseRepeat: { value: new THREE.Vector2(opts.repeat.x, opts.repeat.y) },
        tintColor: { value: new THREE.Color(opts.tintColor ?? 0xffffff) },
        baseReflectivity: { value: opts.baseReflectivity ?? 0.08 },
        cameraWorldPosition: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        uniform mat4 textureMatrix;
        varying vec4 vReflectUv;
        varying vec2 vDiffuseUv;
        varying vec3 vWorldPosition;

        void main() {
          vDiffuseUv = uv;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          vReflectUv = textureMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tReflection;
        uniform sampler2D tDiffuse;
        uniform vec2 diffuseRepeat;
        uniform vec3 tintColor;
        uniform float baseReflectivity;
        uniform vec3 cameraWorldPosition;
        varying vec4 vReflectUv;
        varying vec2 vDiffuseUv;
        varying vec3 vWorldPosition;

        void main() {
          vec4 reflection = texture2DProj(tReflection, vReflectUv);
          vec4 base = texture2D(tDiffuse, vDiffuseUv * diffuseRepeat);

          // Fresnel-Schlick yaklaşımı: dik açıda düşük, sıyırma açısında yüksek yansıtıcılık
          vec3 viewDir = normalize(cameraWorldPosition - vWorldPosition);
          float ndotv = clamp(dot(vec3(0.0, 1.0, 0.0), viewDir), 0.0, 1.0);
          float fresnel = baseReflectivity + (1.0 - baseReflectivity) * pow(1.0 - ndotv, 5.0);
          fresnel = clamp(fresnel, 0.0, 0.92);

          vec3 color = mix(base.rgb, reflection.rgb * tintColor, fresnel);
          gl_FragColor = vec4(color, 1.0);

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    super(geometry, material);

    this.renderTarget = renderTarget;
    this.clipBias = opts.clipBias ?? 0.003;
  }

  private getReflectionCamera(camera: THREE.Camera): THREE.PerspectiveCamera {
    let cam = this.reflectionCameras.get(camera);
    if (!cam) {
      cam = (camera as THREE.PerspectiveCamera).clone();
      this.reflectionCameras.set(camera, cam);
    }
    return cam;
  }

  public onBeforeRender = (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) => {
    const material = this.material;
    const perspCamera = camera as THREE.PerspectiveCamera;

    this._reflectorWorldPosition.setFromMatrixPosition(this.matrixWorld);
    this._cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    this._rotationMatrix.extractRotation(this.matrixWorld);

    this._normal.set(0, 0, 1).applyMatrix4(this._rotationMatrix);
    this._view.subVectors(this._reflectorWorldPosition, this._cameraWorldPosition);

    // Yansıtıcı kameraya bakmıyorsa gereksiz render'dan kaçın
    if (this._view.dot(this._normal) > 0) return;

    this._view.reflect(this._normal).negate();
    this._view.add(this._reflectorWorldPosition);

    this._rotationMatrix.extractRotation(camera.matrixWorld);
    this._lookAtPosition.set(0, 0, -1).applyMatrix4(this._rotationMatrix).add(this._cameraWorldPosition);

    this._target.subVectors(this._reflectorWorldPosition, this._lookAtPosition);
    this._target.reflect(this._normal).negate();
    this._target.add(this._reflectorWorldPosition);

    const reflectionCamera = this.getReflectionCamera(camera);
    reflectionCamera.position.copy(this._view);
    reflectionCamera.up.set(0, 1, 0).applyMatrix4(this._rotationMatrix).reflect(this._normal);
    reflectionCamera.lookAt(this._target);
    reflectionCamera.far = perspCamera.far;
    reflectionCamera.updateMatrixWorld();
    reflectionCamera.projectionMatrix.copy(perspCamera.projectionMatrix);

    // Doku (uv) matrisini güncelle
    const textureMatrix = material.uniforms.textureMatrix.value as THREE.Matrix4;
    textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    textureMatrix.multiply(reflectionCamera.projectionMatrix);
    textureMatrix.multiply(reflectionCamera.matrixWorldInverse);
    textureMatrix.multiply(this.matrixWorld);

    // Eğik (oblique) kırpma düzlemi — Terathon tekniği: yansıma kamerası
    // zeminin altındaki geometriyi render etmesin diye near-plane'i zemine hizalar
    this._reflectorPlane.setFromNormalAndCoplanarPoint(this._normal, this._reflectorWorldPosition);
    this._reflectorPlane.applyMatrix4(reflectionCamera.matrixWorldInverse);
    this._clipPlane.set(
      this._reflectorPlane.normal.x,
      this._reflectorPlane.normal.y,
      this._reflectorPlane.normal.z,
      this._reflectorPlane.constant,
    );

    const projectionMatrix = reflectionCamera.projectionMatrix;
    this._q.x = (Math.sign(this._clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    this._q.y = (Math.sign(this._clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    this._q.z = -1.0;
    this._q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];

    this._clipPlane.multiplyScalar(2.0 / this._clipPlane.dot(this._q));
    projectionMatrix.elements[2] = this._clipPlane.x;
    projectionMatrix.elements[6] = this._clipPlane.y;
    projectionMatrix.elements[10] = this._clipPlane.z + 1.0 - this.clipBias;
    projectionMatrix.elements[14] = this._clipPlane.w;

    material.uniforms.cameraWorldPosition.value.copy(this._cameraWorldPosition);

    // Yansımayı ayrı render-target'a çiz
    this.visible = false;
    const currentRenderTarget = renderer.getRenderTarget();
    const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.renderTarget);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, reflectionCamera);
    renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
    renderer.setRenderTarget(currentRenderTarget);
    this.visible = true;
  };

  public disposeFloor() {
    this.renderTarget.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
      }
