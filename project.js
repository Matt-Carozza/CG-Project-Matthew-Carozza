"use strict";

/* =========================================================
   Globals / Parameters
   ========================================================= */

var canvas, gl, program;

// Snake / IK parameters
const numSegments = 4;
let joints = [];
let segmentLength = 1.25;
let target = vec3(5, 5, 0);

const tolerance = 0.05;
const maxIterations = 20;

// Geometry + buffers
var points = [];            // vertex positions (flattened later)
var colors = [];            // per-vertex colors (vec4s)
var NumVertices = 0;

// link geometry for rectangles
var linkVBuffer = null;
var linkCBuffer = null;
var linkNumVertices = 0;

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
  createCircle(segments, radius)
  returns { vertices: [vec4,...], colors: [vec4,...] }
  Use fan triangulation method to create a flat circle in the XY plane
*/
function createCircle(segments, radius) {
    let verts = [];
    let cols = [];

    // center vertex
    verts.push(vec4(0, 0, 0, 1));
    cols.push(vec4(0.545, 0.1, 0.1, 1.0));

    for (let i = 0; i <= segments; i++) {
        let angle = (i / segments) * 2 * Math.PI;
        let x = radius * Math.cos(angle);
        let y = radius * Math.sin(angle);
        verts.push(vec4(x, y, 0, 1));
        cols.push(vec4(0.545, 0.1, 0.1, 1.0));
    }

    return { vertices: verts, colors: cols };
}

function createUnitRect() {
    // Rectangle from x = 0 --> 1, centered on y = 0
    return {
        vertices: [
            vec4(0, -0.5, 0, 1),
            vec4(1, -0.5, 0, 1),
            vec4(1,  0.5, 0, 1),

            vec4(0, -0.5, 0, 1),
            vec4(1,  0.5, 0, 1),
            vec4(0,  0.5, 0, 1),
        ],
        colors: [
            vec4(0.6, 0.6, 0.6, 1),
            vec4(0.6, 0.6, 0.6, 1),
            vec4(0.6, 0.6, 0.6, 1),
            vec4(0.6, 0.6, 0.6, 1),
            vec4(0.6, 0.6, 0.6, 1),
            vec4(0.6, 0.6, 0.6, 1),
        ]
    };
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
   Mouse / canvas 
   ========================================================= */

/*
  canvasToWorld(evt)
*/

function canvasToWorld(evt) {
    const rect = canvas.getBoundingClientRect();

    // normalized device coords in [0,1]
    const nx = (evt.clientX - rect.left) / rect.width;
    const ny = (evt.clientY - rect.top)  / rect.height;
    
    // Match to canvas
    const worldHeight = 20;
    const aspect = canvas.width / canvas.height;
    const worldWidth = worldHeight * aspect;
    
    const left = -worldWidth / 2;
    const right = worldWidth / 2;
    const bottom = -worldHeight / 2;
    const top = worldHeight / 2;

    // map to world coordinates; note Y is inverted between screen and world
    const worldX = left + nx * (right - left);
    const worldY = bottom + (1 - ny) * (top - bottom);

    return vec3(worldX, worldY, 0);
}


/* =========================================================
   FABRIK implementation 
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


// Draw a circle (triangle fan) at position with uniform scale
function drawCircle(position, scaleFactor) {
    // build model matrix: translate then scale 
    var s = scale4(scaleFactor, scaleFactor, 1.0); // keep z=1
    var instanceMatrix = mult(translate(position[0], position[1], position[2]), s);
    var t = mult(modelViewMatrix, instanceMatrix);
    gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(t));

    // Draw fan
    gl.drawArrays(gl.TRIANGLE_FAN, 0, NumVertices);
}


// Draw target circle using a separate color buffer temporarily
function drawTargetCircle(position, scaleFactor) {
    gl.bindBuffer(gl.ARRAY_BUFFER, targetCBuffer);
    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);

    drawCircle(position, scaleFactor);

    // restore body color buffer to the attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, cBuffer);
    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);
}

// draw a rectangular link between joint A and joint B
// thickness is in world units (height of the rectangle)
function drawLink(jA, jB, thickness) {
    // vector from A -> B
    const dx = jB[0] - jA[0];
    const dy = jB[1] - jA[1];
    const length = Math.sqrt(dx*dx + dy*dy);

    if (length < 1e-6) return; // avoid degenerate links

    // angle in radians from +X to the vector A->B
    const angleRad = Math.atan2(dy, dx);
    // convert to degrees 
    const angleDeg = angleRad * 180.0 / Math.PI;

    // Transform: T(jA) * R(angle) * S(length, thickness, 1)
    // unit rect spans x=0..1 so scaling by length makes x=0..length (jA->jB)
    const instanceMatrix = mult(
        translate(jA[0], jA[1], 0.0),
        mult(rotateZ(-angleDeg), scale4(length, thickness, 1.0))
    );
    const t = mult(modelViewMatrix, instanceMatrix);
    gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(t));

    // Bind rectangle position & color buffers and draw
    gl.bindBuffer(gl.ARRAY_BUFFER, linkVBuffer);
    gl.vertexAttribPointer(vPositionLoc, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vPositionLoc);

    gl.bindBuffer(gl.ARRAY_BUFFER, linkCBuffer);
    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vColorLoc);

    gl.drawArrays(gl.TRIANGLES, 0, linkNumVertices);

    // restore circle buffers (so subsequent drawCircle calls use them)
    gl.bindBuffer(gl.ARRAY_BUFFER, vBuffer);
    gl.vertexAttribPointer(vPositionLoc, 4, gl.FLOAT, false, 0, 0);
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

    // Load shaders once
    program = initShaders(gl, "vertex-shader", "fragment-shader");
    gl.useProgram(program);

    // Cache attribute/uniform locations
    vPositionLoc = gl.getAttribLocation(program, "vPosition");
    vColorLoc    = gl.getAttribLocation(program, "vColor");
    modelViewMatrixLoc = gl.getUniformLocation(program, "modelViewMatrix");
    projectionMatrixLoc = gl.getUniformLocation(program, "projectionMatrix");

    // Create circle geometry (low-poly)
    const circle = createCircle(32, 0.5);
    points = circle.vertices;
    colors = circle.colors;
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

    // Create unit rectangle geometry for links
    const rect = createUnitRect();
    linkNumVertices = rect.vertices.length;

    linkVBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, linkVBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(rect.vertices), gl.STATIC_DRAW);
    
    linkCBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, linkCBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(rect.colors), gl.STATIC_DRAW);

    // Save original colors (flattened Float32Array)
    originalColorsBuffer = flatten(colors);

    // Projection matrix (orthographic)
    projectionMatrix = ortho(-10, 10, -10, 10, 0, 1);
    gl.uniformMatrix4fv(projectionMatrixLoc, false, flatten(projectionMatrix));

    // Initialize joints linearly along +x
    joints = [];
    for (let i = 0; i < numSegments; i++) {
        joints.push(vec3(i * segmentLength, 0, 0));
    }
    
    resizeCanvas();

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
   Screen setup
   ========================================================= */
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    console.log(canvas.width - 50, canvas.height - 50);
    gl.viewport(0, 0, canvas.width, canvas.height);
    
    // Adjust orthographic projection to maintain world bounds
    const aspect = canvas.width / canvas.height;
    const worldHeight = 20; 
    const worldWidth = worldHeight * aspect; 
    projectionMatrix = ortho(-worldWidth/2, worldWidth/2, -worldHeight/2, worldHeight/2, -10, 10);
    gl.uniformMatrix4fv(projectionMatrixLoc, false, flatten(projectionMatrix));
}

window.addEventListener('load', () => {
    canvas = document.getElementById("gl-canvas");
    gl = WebGLUtils.setupWebGL(canvas);
    if (!gl) { alert("WebGL isn't available"); return; }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
});


/* =========================================================
   Render loop
   ========================================================= */

var render = function() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // camera (must match canvasToWorld)
    modelViewMatrix = mat4()
    gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(modelViewMatrix));

    // FABRIK update
    fabrik(target);

    // Draw body (uses body color buffer)
    gl.bindBuffer(gl.ARRAY_BUFFER, vBuffer);
    gl.vertexAttribPointer(vPositionLoc, 4, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, cBuffer);
    gl.vertexAttribPointer(vColorLoc, 4, gl.FLOAT, false, 0, 0);
    
    // Draw links first (so joints overlap them)
    for (let i = 0; i < numSegments - 1; i++) {
        drawLink(joints[i], joints[i + 1], 0.2);  
    }

    for (let i = 0; i < numSegments; i++) {
        drawCircle(joints[i], 0.4);
    }

    // Draw target last (uses target color buffer temporarily)
    drawTargetCircle(target, 0.3);

    requestAnimFrame(render);
};