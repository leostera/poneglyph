import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type PoneglyphLogo3DProps = {
  fallbackSrc?: string;
  textureSrc?: string;
  size?: number;
  alt?: string;
  className?: string;
};

export function PoneglyphLogo3D({
  fallbackSrc = "/poneglyph.svg",
  textureSrc = "/poneglyph_texture.svg",
  size = 50,
  alt = "Poneglyph logo",
  className,
}: PoneglyphLogo3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [webglAvailable, setWebglAvailable] = useState(true);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !canUseWebGL()) {
      setWebglAvailable(false);
      return;
    }

    let frameId = 0;
    let isDragging = false;
    let pointerInside = false;
    let dragVelocityX = 0;
    let dragVelocityY = 0;
    let rotationY = 0.45;
    let rotationX = -0.3;
    let cancelled = false;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0, 5.4);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.35);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(3.2, 2.4, 4.6);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xbdbdbd, 0.8);
    rimLight.position.set(-2.4, -1.6, -3.4);
    scene.add(rimLight);

    const geometry = new THREE.BoxGeometry(1.55, 1.55, 1.55);
    const cleanupTexture = loadCubeNetMaterials(textureSrc)
      .then((materials) => {
        if (cancelled) {
          for (const material of materials) {
            material.map?.dispose();
            material.dispose();
          }
          geometry.dispose();
          return () => {};
        }

        const cube = new THREE.Mesh(geometry, materials);
        cube.rotation.set(rotationX, rotationY, 0.18);
        cube.position.y = 0.08;
        scene.add(cube);

        const animate = () => {
          frameId = window.requestAnimationFrame(animate);

          if (!isDragging) {
            rotationY += 0.007;
            dragVelocityX *= 0.92;
            dragVelocityY *= 0.92;
          }

          rotationY += dragVelocityY;
          rotationX += dragVelocityX;

          cube.rotation.y = rotationY;
          cube.rotation.x = rotationX;
          cube.rotation.z = 0.18;

          renderer.render(scene, camera);
        };

        animate();

        return () => {
          scene.remove(cube);
          geometry.dispose();
          for (const material of materials) {
            material.map?.dispose();
            material.dispose();
          }
        };
      })
      .catch(() => {
        const fallbackMaterials = createFallbackMaterials();
        if (cancelled) {
          for (const material of fallbackMaterials) {
            material.dispose();
          }
          geometry.dispose();
          return () => {};
        }

        const cube = new THREE.Mesh(geometry, fallbackMaterials);
        cube.rotation.set(rotationX, rotationY, 0.18);
        cube.position.y = 0.08;
        scene.add(cube);

        const animate = () => {
          frameId = window.requestAnimationFrame(animate);

          if (!isDragging) {
            rotationY += 0.007;
            dragVelocityX *= 0.92;
            dragVelocityY *= 0.92;
          }

          rotationY += dragVelocityY;
          rotationX += dragVelocityX;

          cube.rotation.y = rotationY;
          cube.rotation.x = rotationX;
          cube.rotation.z = 0.18;

          renderer.render(scene, camera);
        };

        animate();

        return () => {
          scene.remove(cube);
          geometry.dispose();
          for (const material of fallbackMaterials) {
            material.dispose();
          }
        };
      });

    const onPointerDown = () => {
      isDragging = true;
    };

    const onPointerUp = () => {
      isDragging = false;
    };

    const onPointerEnter = () => {
      pointerInside = true;
    };

    const onPointerLeave = () => {
      pointerInside = false;
      isDragging = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isDragging || !pointerInside) {
        return;
      }

      dragVelocityY = event.movementX * 0.012;
      dragVelocityX = event.movementY * 0.012;
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerenter", onPointerEnter);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("pointermove", onPointerMove);

    return () => {
      cancelled = true;
      void cleanupTexture.then((disposeScene) => {
        disposeScene();
      });
      window.cancelAnimationFrame(frameId);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerenter", onPointerEnter);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [size, textureSrc]);

  if (!webglAvailable) {
    return <img alt={alt} className={className} height={size} src={fallbackSrc} width={size} />;
  }

  return (
    <div
      aria-label={alt}
      className={className}
      ref={mountRef}
      style={{ width: size, height: size, cursor: "grab" }}
    />
  );
}

function createFallbackMaterials() {
  return [
    new THREE.MeshStandardMaterial({ color: "#5A6A7B", roughness: 0.46, metalness: 0.06 }),
    new THREE.MeshStandardMaterial({ color: "#394455", roughness: 0.5, metalness: 0.08 }),
    new THREE.MeshStandardMaterial({ color: "#6F8598", roughness: 0.4, metalness: 0.04 }),
    new THREE.MeshStandardMaterial({ color: "#94A6B6", roughness: 0.34, metalness: 0.03 }),
    new THREE.MeshStandardMaterial({ color: "#4A5969", roughness: 0.48, metalness: 0.06 }),
    new THREE.MeshStandardMaterial({ color: "#253147", roughness: 0.52, metalness: 0.08 }),
  ];
}

async function loadCubeNetMaterials(textureSrc: string) {
  const image = await loadImage(textureSrc);
  const faceRects = resolveCubeNetFaceRects(image);
  const textureFaces = {
    right: createFaceTexture(image, faceRects.right, { flipX: true }),
    left: createFaceTexture(image, faceRects.left, { flipX: true }),
    top: createFaceTexture(image, faceRects.top, { rotateQuarterTurns: 2 }),
    bottom: createFaceTexture(image, faceRects.bottom, { rotateQuarterTurns: 2 }),
    front: createFaceTexture(image, faceRects.front),
  };
  const back = createFaceTexture(image, faceRects.front, { flipX: true });

  return [
    new THREE.MeshStandardMaterial({ map: textureFaces.right, roughness: 0.7, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ map: textureFaces.left, roughness: 0.7, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ map: textureFaces.top, roughness: 0.7, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ map: textureFaces.bottom, roughness: 0.7, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ map: textureFaces.front, roughness: 0.7, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ map: back, roughness: 0.7, metalness: 0.02 }),
  ];
}

function createFaceTexture(
  image: HTMLImageElement,
  rect: FaceRect,
  options: FaceTextureOptions = {},
) {
  const canvas = document.createElement("canvas");
  canvas.width = rect.size;
  canvas.height = rect.size;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas context unavailable");
  }

  const inset = Math.round(rect.size * 0.02);
  const sourceX = rect.x + inset;
  const sourceY = rect.y + inset;
  const sourceSize = rect.size - inset * 2;

  context.fillStyle = "#5A6A7B";
  context.fillRect(0, 0, rect.size, rect.size);

  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = rect.size;
  faceCanvas.height = rect.size;
  const faceContext = faceCanvas.getContext("2d");
  if (!faceContext) {
    throw new Error("2D canvas context unavailable");
  }

  faceContext.fillStyle = "#5A6A7B";
  faceContext.fillRect(0, 0, rect.size, rect.size);

  faceContext.drawImage(
    image,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    0,
    0,
    rect.size,
    rect.size,
  );

  drawTransformedFace(context, faceCanvas, options);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

type FaceRect = {
  x: number;
  y: number;
  size: number;
};

type FaceTextureOptions = {
  rotateQuarterTurns?: 0 | 1 | 2 | 3;
  flipX?: boolean;
  flipY?: boolean;
};

function resolveCubeNetFaceRects(image: HTMLImageElement) {
  const scaleX = image.width / 1024;
  const scaleY = image.height / 1024;
  const faceRects = {
    top: { x: 372, y: 61, size: 281 },
    left: { x: 90, y: 358, size: 282 },
    front: { x: 372, y: 358, size: 281 },
    right: { x: 653, y: 358, size: 281 },
    bottom: { x: 372, y: 640, size: 282 },
  } satisfies Record<"top" | "left" | "front" | "right" | "bottom", FaceRect>;

  return {
    top: scaleFaceRect(faceRects.top, scaleX, scaleY),
    left: scaleFaceRect(faceRects.left, scaleX, scaleY),
    front: scaleFaceRect(faceRects.front, scaleX, scaleY),
    right: scaleFaceRect(faceRects.right, scaleX, scaleY),
    bottom: scaleFaceRect(faceRects.bottom, scaleX, scaleY),
  };
}

function scaleFaceRect(rect: FaceRect, scaleX: number, scaleY: number) {
  return {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    size: Math.round(rect.size * Math.min(scaleX, scaleY)),
  };
}

function drawTransformedFace(
  context: CanvasRenderingContext2D,
  faceCanvas: HTMLCanvasElement,
  options: FaceTextureOptions,
) {
  const { width, height } = faceCanvas;
  const rotateQuarterTurns = options.rotateQuarterTurns ?? 0;

  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((Math.PI / 2) * rotateQuarterTurns);
  context.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1);
  context.drawImage(faceCanvas, -width / 2, -height / 2, width, height);
  context.restore();
}

function canUseWebGL() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}
