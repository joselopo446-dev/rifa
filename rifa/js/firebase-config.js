// Configuración de Firebase - Treebolito
// NO MODIFICAR ESTE ARCHIVO - Las credenciales ya están configuradas

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCCrsHE4maOWXu06ADT7W6wMXWXzK0wSMo",
  authDomain: "treebolito.firebaseapp.com",
  projectId: "treebolito",
  storageBucket: "treebolito.firebasestorage.app",
  messagingSenderId: "321841443031",
  appId: "1:321841443031:web:f8b97c0802150ecee04092",
  measurementId: "G-20EFETFMW1"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);

// Exportar Firestore
const db = getFirestore(app);

export { db };
