"use strict";

/* =========================================================
   Globals / Parameters
   ========================================================= */

var canvas, gl, program;

// Snake / IK parameters
const numSegments = 24;
let joints = [];
let segmentLength = 0.35;
let target = vec3(5, 5, 0);

const tolerance = 0.05;
const maxIterations = 20;

// Geometry + buffers
var points = [];            // vertex positions (flattened later)
var colors = [];            // per-vertex colors (vec4s)
var NumVertices = 0;

var vBuffer = null;         // position buffer
var cBuffer = null;         // body color buffer
var targetCBuffer = null;   // target color buffer

// Matrices / shader locations
var modelViewMatrix, projectionMatrix;
var modelViewMatrixLoc;
var projectionMatrixLoc;
var vPositionLoc;
var vColorLoc;

// Misc
var originalColorsBuffer = null;

/* =========================================================
   Geometry helpers
   ========================================================= */

/*
  createSphere(latBands, longBands, radius)
  returns { vertices: [vec4,...], colors: [vec4,...] }
  low-poly sphere generator (unlit, flat color per-vertex)
*/
function createSphere(latBands, longBands, radius) {
    let verts = [];
    let cols = [];

    for (let lat = 0; lat <= latBands; lat++) {
        let theta = lat * Math.PI / latBands;
        let sinTheta = Math.sin(theta);
        let cosTheta = Math.cos(theta);

        for (let lon = 0; lon <= longBands; lon++) {
            let phi = lon * 2 * Math.PI / longBands;
            let sinPhi = Math.sin(phi);
            let cosPhi = Math.cos(phi);

            let x = cosPhi * sinTheta;
            let y = cosTheta;
            let z = sinPhi * sinTheta;

            // store as vec4 to match shader attribute (vPosition is vec4)
            verts.push(vec4(radius * x, radius * y, radius * z, 1.0));
            // flat color for body (change later if desired)
            cols.push(vec4(0.1, 0.7, 0.2, 1.0)); // greenish
        }
    }

    // indices -> triangles
    let indices = [];
    for (let lat = 0; lat < latBands; lat++) {
        for (let lon = 0; lon < longBands; lon++) {
            let first = (lat * (longBands + 1)) + lon;
            let second = first + longBands + 1;
            indices.push(first, second, first + 1);
            indices.push(second, second + 1, first + 1);
        }
    }

    // expand indexed to flat triangle list
    let outVerts = [];
    let outCols = [];
    for (let i = 0; i < indices.length; i++) {
        let idx = indices[i];
        outVerts.push(verts[idx]);
        outCols.push(cols[idx]);
    }

    return { vertices: outVerts, colors: outCols };
}

/* =========================================================
   Utility helpers (vectors, small helpers)
   ========================================================= */

function distance(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function copyVec3(a) {
    return vec3(a[0], a[1], a[2]);
}

/* =========================================================
   Mouse / canvas coordinate -> world unprojection
   ========================================================= */

/*
  canvasToWorld(evt)
  Converts mouse event to world-space intersection with z=0 plane.
  Uses the same camera transforms used during rendering.
*/

function canvasToWorld(evt) {
    // // Convert to Normalized Device Coordinates (NDC)
    // const ndcX = (x / rect.width) * 2 - 1;
    // const ndcY = 1 - (y / rect.height) * 2;

    // // Camera transforms
    // const cameraMV = mat4();
    // const rotatedMV = mult(rotateY(30), rotateX(-20));
    // const modelViewForUnProjection = mult(cameraMV, rotatedMV);

    // // Compose projection * modelview
    // const projModel = mult(projectionMatrix, modelViewForUnProjection);

    // // Invert safely
    // let invPM;
    // try {
    //     invPM = inverse(projModel);
    //     if (!invPM || !invPM.every(isFinite)) throw "Invalid inverse";
    // } catch {
    //     // fallback: simple ortho mapping
    //     return vec3(ndcX * 10, ndcY * 10, 0);
    // }

    // // Homogeneous clip coords (near/far)
    // const clipNear = vec4(ndcX, ndcY, -1, 1);
    // const clipFar  = vec4(ndcX, ndcY,  1, 1);

    // const worldNearH = mult(invPM, clipNear);
    // const worldFarH  = mult(invPM, clipFar);

    // // Convert from homogeneous to 3D
    // const worldNear = vec3(worldNearH[0] / worldNearH[3],
    //                        worldNearH[1] / worldNearH[3],
    //                        worldNearH[2] / worldNearH[3]);
    // const worldFar  = vec3(worldFarH[0]  / worldFarH[3],
    //                        worldFarH[1]  / worldFarH[3],
    //                        worldFarH[2]  / worldFarH[3]);

    // // Ray from near -> far
    // const rayDir = subtract(worldFar, worldNear);

    // // Intersect with z=0 plane
    // if (Math.abs(rayDir[2]) < 1e-6) {
    //     // nearly parallel
    //     return vec3(worldNear[0], worldNear[1], 0);
    // }
    // const t = -worldNear[2] / rayDir[2];
    // return add(worldNear, scale(t, rayDir));    
    const rect = canvas.getBoundingClientRect();

    // normalized device coords in [0,1]
    const nx = (evt.clientX - rect.left) / rect.width;
    const ny = (evt.clientY - rect.top)  / rect.height;

    // your orthographic extents (must match the values used for projection)
    const left = -10, right = 10, bottom = -10, top = 10;

    // map to world coordinates; note Y is inverted between screen and world
    const worldX = left + nx * (right - left);
    const worldY = bottom + (1 - ny) * (top - bottom);

    return vec3(worldX, worldY, 0);
}


/* =========================================================
   FABRIK implementation (unchanged, minor safety fixes)
   ========================================================= */

function fabrik(targetPos) {
    // Base position
    const base = joints[0];
    const totalLength = segmentLength * (numSegments - 1);
    const distBaseToTarget = distance(base, targetPos);

    // If unreachable: stretch straight toward target
    if (distBaseToTarget > totalLength) {
        const dir = normalize(subtract(targetPos, base));
        for (let i = 1; i < joints.length; i++) {
            const r = segmentLength * i;
            joints[i] = add(base, scale(r, dir));
        }
        return;
    }

    // If reachable: iterate FABRIK
    const b = vec3(base[0], base[1], base[2]); // store original base
    let iter = 0;
    while (iter < maxIterations) {
        // Forward pass: set end to target then move toward base
        joints[joints.length - 1] = copyVec3(targetPos);
        for (let i = joints.length - 2; i >= 0; i--) {
            const r = distance(joints[i + 1], joints[i]);
            const eps = 1e-9;
            const safeR = Math.max(r, eps);
            const lambda = segmentLength / safeR;
            joints[i] = mix(joints[i + 1], joints[i], lambda);
        }

        // Backward pass: restore base and propagate outwards
        joints[0] = copyVec3(b);
        for (let i = 0; i < joints.length - 1; i++) {
            const r = distance(joints[i + 1], joints[i]);
            const safeR = Math.max(r, 1e-9);
            const lambda = segmentLength / safeR;
            joints[i + 1] = mix(joints[i], joints[i + 1], lambda);
        }

        // Convergence check
        const tipDistance = distance(joints[joints.length - 1], targetPos);
        if (tipDistance < tolerance) break;
        iter++;
    }
}

/* =========================================================
   Drawing Helpers
   ========================================================= */

function scale4(a, b, c) {
   var result = mat4();
   result[0][0] = a;
   result[1][1] = b;
   result[2][2] = c;
   return result;
}

// Draw a sphere mesh at position with uniform scale
function drawSphere(position, scaleFactor) {
    var s = scale4(scaleFactor, scaleFactor, scaleFactor);
    var instanceMatrix = mult(translate(position[0], position[1], position[2]), s);
    var t = mult(modelViewMatrix, instanceMatrix);
    gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(t));
    gl.drawArrays(gl.TRIANGLES, 0, NumVertices);
}

// Draw target sphere using a separate color buffer so body colors aren't overwritten
function drawTargetSphere(position, scaleFactor) {
    // bind target color buffer (attribute pointer must point to this buffer)
    gl.bindBuffer(gl.ARRAY_BUFFER, targetCBuffer);
    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);

    drawSphere(position, scaleFactor);

    // restore body color buffer to the attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, cBuffer);
    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);
}

/* =========================================================
   Initialization and setup
   ========================================================= */

window.onload = function init() {
    canvas = document.getElementById("gl-canvas");
    gl = WebGLUtils.setupWebGL(canvas);
    if (!gl) { alert("WebGL isn't available"); return; }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.enable(gl.DEPTH_TEST);

    // Load shaders once
    program = initShaders(gl, "vertex-shader", "fragment-shader");
    gl.useProgram(program);

    // Cache attribute/uniform locations
    vPositionLoc = gl.getAttribLocation(program, "vPosition");
    vColorLoc    = gl.getAttribLocation(program, "vColor");
    modelViewMatrixLoc = gl.getUniformLocation(program, "modelViewMatrix");
    projectionMatrixLoc = gl.getUniformLocation(program, "projectionMatrix");

    // Create sphere geometry (low-poly)
    const sph = createSphere(8, 8, 0.5);
    points = sph.vertices;
    colors = sph.colors;
    NumVertices = points.length;

    // Create and fill position buffer
    vBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(points), gl.STATIC_DRAW);

    gl.vertexAttribPointer(vPositionLoc, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vPositionLoc);

    // Create and fill body color buffer
    cBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(colors), gl.STATIC_DRAW);

    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vColorLoc);

    // Create target color buffer (pre-filled with red)
    targetCBuffer = gl.createBuffer();
    const redArray = new Float32Array(NumVertices * 4);
    for (let i = 0; i < NumVertices; i++) {
        redArray[i*4 + 0] = 1.0;
        redArray[i*4 + 1] = 0.2;
        redArray[i*4 + 2] = 0.2;
        redArray[i*4 + 3] = 1.0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, targetCBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, redArray, gl.STATIC_DRAW);

    // Save original colors (flattened Float32Array)
    originalColorsBuffer = flatten(colors);

    // Projection matrix (orthographic)
    projectionMatrix = ortho(-10, 10, -10, 10, -10, 10);
    gl.uniformMatrix4fv(projectionMatrixLoc, false, flatten(projectionMatrix));

    // Initialize joints linearly along +x
    joints = [];
    for (let i = 0; i < numSegments; i++) {
        joints.push(vec3(i * segmentLength, 0, 0));
    }

    setupMouse();
    render();
};

/* =========================================================
   Mouse handler
   ========================================================= */

function setupMouse() {
    canvas.addEventListener("mousedown", function(evt) {
        const worldPos = canvasToWorld(evt);
        console.log("World Pos:", worldPos);
        target[0] = worldPos[0];
        target[1] = worldPos[1];
        target[2] = 0;
    });

    // enable hover-follow later with mousemove
    // canvas.addEventListener("mousemove", (evt) => { ... });
}

/* =========================================================
   Render loop
   ========================================================= */

var render = function() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // camera (must match canvasToWorld)
    modelViewMatrix = mat4();
    modelViewMatrix = mult(modelViewMatrix, rotateY(30));
    modelViewMatrix = mult(modelViewMatrix, rotateX(-20));

    // FABRIK update
    fabrik(target);

    // Draw body (uses body color buffer)
    gl.bindBuffer(gl.ARRAY_BUFFER, vBuffer);
    gl.vertexAttribPointer(vPositionLoc, 4, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cBuffer);
    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);

    for (let i = 0; i < numSegments; i++) {
        drawSphere(joints[i], 0.4);
    }

    // Draw target last (uses target color buffer temporarily)
    drawTargetSphere(target, 0.3);

    requestAnimFrame(render);
};