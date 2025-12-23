/*
 * "Nothing Stones"
 * Creator: @MartinSeeger2
 * Description:
 *     "Nothing Stones" is an innovative NFT collection built on the Dogecoin blockchain, showcasing 3333 uniquely crafted NFTs
 *     that explore the theme of 'Nothingness'. Each NFT is a testament to the possibilities within the realm of digital art and blockchain technology.
 *
 * Technical Details:
 *     - Recursive Inscription Technology: This collection leverages advanced recursive inscription techniques to embed each NFT 
 *       directly onto the Dogecoin blockchain. This method uses a recursive script that continuously inscribes data into Dogecoin transactions,
 *       allowing for each NFT to not only be unique but also permanently stored and verifiable on the blockchain.
 *
 *     - Three.js Integration: The visual representation of each NFT is rendered dynamically in 3D using the Three.js library, which is a 
 *       powerful tool for creating and displaying animated 3D graphics in a web browser. This approach provides an interactive experience,
 *       where collectors can manipulate and engage with their NFTs directly through a web interface.
 *
 *     - HTML Configuration: The collection's HTML file plays a crucial role in defining the aesthetic aspects of the NFTs. It specifies 
 *       the text content, size, and color for each NFT, allowing for easy adjustments and customization. By externalizing these properties
 *       in the HTML, the collection enables a flexible framework where visual elements can be dynamically altered without modifying the 
 *       core rendering logic.
 *
 * Impact:
 *     "Nothing Stones" not only pushes the boundaries of what digital collectibles can represent but also showcases the merging of art 
 *     with cutting-edge blockchain and web technologies. It stands as a pivotal project in the NFT space, highlighting how technical 
 *     innovation can lead to new forms of artistic expression and collector interaction.
 */

function initializeScene(config) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('container').appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight.position.set(0, 1, 1);
    scene.add(directionalLight);

    const textMeshes = [];
    const loader = new THREE.FontLoader();
    loader.load('/content/d3727883744d428950c46933f673516e559b3aba2fc0be1a77c99ffbf2c61f04i0', font => {
        textMeshes.push(createText(font, config.text1, 30));
        textMeshes.push(createText(font, config.text2, -50));
    });

    function createText(font, textConfig, positionY) {
        const geometry = new THREE.TextGeometry(textConfig.content, {
            font: font,
            size: window.innerWidth * textConfig.size,
            height: window.innerWidth * textConfig.height,
            curveSegments: 12,
            bevelEnabled: true,
            bevelThickness: textConfig.size * 2,
            bevelSize: textConfig.size * 2,
            bevelSegments: 5
        });
        geometry.center();
        const material = new THREE.MeshPhongMaterial({ color: textConfig.color });
        const textMesh = new THREE.Mesh(geometry, material);
        textMesh.position.z = -500;
        textMesh.position.y = positionY;
        scene.add(textMesh);
        return textMesh;
    }

    window.addEventListener('resize', onWindowResize, false);

    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    let isDragging = false;
    let previousMousePosition = { x: 0, y: 0 };

    document.addEventListener('mousedown', e => {
        isDragging = true;
        previousMousePosition.x = e.clientX;
        previousMousePosition.y = e.clientY;
    });

    document.addEventListener('mousemove', e => {
        if (isDragging) {
            const deltaMove = {
                x: e.clientX - previousMousePosition.x,
                y: e.clientY - previousMousePosition.y
            };

            textMeshes.forEach(mesh => {
                mesh.rotation.y += deltaMove.x * 0.005;
                mesh.rotation.x += deltaMove.y * 0.005;
            });

            previousMousePosition.x = e.clientX;
            previousMousePosition.y = e.clientY;
        }
    });

    document.addEventListener('mouseup', e => {
        isDragging = false;
    });

    function animate() {
        requestAnimationFrame(animate);
        if (!isDragging) {
            textMeshes.forEach(mesh => {
                mesh.rotation.y += 0.001; // Slow automatic rotation
            });
        }
        renderer.render(scene, camera);
    }
    animate();
}
