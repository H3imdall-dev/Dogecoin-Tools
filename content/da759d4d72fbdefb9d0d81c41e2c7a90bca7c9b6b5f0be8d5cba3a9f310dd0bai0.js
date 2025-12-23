        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer();
        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);

        const loader = new THREE.TextureLoader();
        const materials = [
        new THREE.MeshPhongMaterial({ map: loader.load('/content/53ed29d8c6b06e6e54d4db2d3e577bbf69354969f9aaa6f2af655ce52fd9c77ai0') }), // right side
        new THREE.MeshPhongMaterial({ map: loader.load('/content/53ed29d8c6b06e6e54d4db2d3e577bbf69354969f9aaa6f2af655ce52fd9c77ai0') }), // left side
        new THREE.MeshPhongMaterial({ map: loader.load('/content/53ed29d8c6b06e6e54d4db2d3e577bbf69354969f9aaa6f2af655ce52fd9c77ai0') }), // top side
        new THREE.MeshPhongMaterial({ map: loader.load('/content/53ed29d8c6b06e6e54d4db2d3e577bbf69354969f9aaa6f2af655ce52fd9c77ai0') }), // bottom side
        new THREE.MeshPhongMaterial({ map: loader.load('/content/53ed29d8c6b06e6e54d4db2d3e577bbf69354969f9aaa6f2af655ce52fd9c77ai0') }), // front side
        new THREE.MeshPhongMaterial({ map: loader.load('/content/9e542edf2b114b0ff653aff36bc9b929c8dea0813c95191d86e821d0f7441b4fi0') })  // back side
        ];

        // add light
        const light = new THREE.DirectionalLight(0xffffff, 1);
        light.position.set(0, 1, 1).normalize();
        scene.add(light);

        // Creating a dim ambient light
        const ambientLight = new THREE.AmbientLight(0x0000ff, 0.2); // white light with low intensity
        scene.add(ambientLight);



        // Create a cube
        const geometry = new THREE.BoxGeometry();
        const cube = new THREE.Mesh(geometry, materials);
        scene.add(cube);

        // Set initial scale and rotation of the cube
        cube.scale.set(3, 3, 3);

        cube.rotation.x = Math.PI / 6; // Rotate 30 degrees around X-axis
        cube.rotation.y = Math.PI / 6; // Rotate 45 degrees around Y-axis
        cube.rotation.z = Math.PI / 12; // Rotate 15 degrees around Z-axis


        camera.position.z = 5;

        let isDragging = false;
        let previousMousePosition = {
            x: 0,
            y: 0
        };

        renderer.domElement.addEventListener('mousedown', e => {
            isDragging = true;
        });

        renderer.domElement.addEventListener('mousemove', e => {
            if (isDragging) {
                const deltaMove = {
                    x: e.offsetX - previousMousePosition.x,
                    y: e.offsetY - previousMousePosition.y
                };

                const rotationSpeed = 0.005;

                cube.rotation.y += deltaMove.x * rotationSpeed;
                cube.rotation.x += deltaMove.y * rotationSpeed;
            }

            previousMousePosition = {
                x: e.offsetX,
                y: e.offsetY
            };
        });

        renderer.domElement.addEventListener('mouseup', e => {
            isDragging = false;
        });

        window.addEventListener('resize', () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            renderer.setSize(width, height);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        });

        function animate() {
            requestAnimationFrame(animate);
            renderer.render(scene, camera);
        }

        animate();
