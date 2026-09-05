import { MongoClient } from "mongodb";

/**
 * Conector y sincronizador bidireccional resiliente con MongoDB Atlas.
 * - Mantiene el estado en memoria para lecturas ultrarrápidas sin latencia.
 * - En el arranque: si MongoDB tiene datos, los sincroniza a memoria.
 *   Si MongoDB está vacío, migra automáticamente la base de datos local (state.json).
 * - En cada escritura (upsert, audit, addUsage): actualiza MongoDB en segundo plano.
 */
export async function connectMongoStore(store, mongoUri, dbName = "monexa") {
  if (!mongoUri) return null;
  try {
    const client = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000
    });
    await client.connect();
    const db = client.db(dbName);
    console.log(`[MongoDB Atlas] Conexión establecida con éxito a la base de datos '${dbName}'`);

    const collections = [
      "agents", "opportunities", "jobs", "ledger",
      "services", "audit", "usage", "trading",
      "trades", "signals", "proposals"
    ];

    // 1. Sincronización inicial
    let totalLoaded = 0;
    let totalMigrated = 0;

    for (const name of collections) {
      const col = db.collection(name);
      const count = await col.countDocuments();
      if (count > 0) {
        // Cargar desde MongoDB a memoria
        const docs = await col.find({}, { projection: { _id: 0 } }).toArray();
        store.state[name] = docs;
        totalLoaded += docs.length;
      } else if (store.state[name] && store.state[name].length > 0) {
        // MongoDB está vacío para esta colección: migrar datos locales existentes
        const docs = store.state[name].map((d) => ({ ...d }));
        if (docs.length > 0) {
          await col.insertMany(docs, { ordered: false }).catch(() => {});
          totalMigrated += docs.length;
        }
      }
    }

    if (totalLoaded > 0) {
      console.log(`[MongoDB Atlas] Sincronizados ${totalLoaded} documentos desde la nube a memoria.`);
    }
    if (totalMigrated > 0) {
      console.log(`[MongoDB Atlas] Migración inicial completada: ${totalMigrated} documentos locales subidos a MongoDB Atlas.`);
    }

    // 2. Interceptar escrituras para persistir en MongoDB en segundo plano
    const originalUpsert = store.upsert.bind(store);
    store.upsert = (collection, record) => {
      const result = originalUpsert(collection, record);
      if (collections.includes(collection)) {
        db.collection(collection)
          .replaceOne({ id: result.id }, { ...result }, { upsert: true })
          .catch((err) => console.error(`[MongoDB] Error al guardar en ${collection}:`, err.message));
      }
      return result;
    };

    const originalAudit = store.audit.bind(store);
    store.audit = (event) => {
      const entry = originalAudit(event);
      db.collection("audit")
        .insertOne({ ...entry })
        .catch((err) => console.error("[MongoDB] Error al guardar auditoría:", err.message));
      return entry;
    };

    const originalAddUsage = store.addUsage.bind(store);
    store.addUsage = (usage) => {
      originalAddUsage(usage);
      db.collection("usage")
        .insertOne({ at: new Date().toISOString(), ...usage })
        .catch((err) => console.error("[MongoDB] Error al guardar uso:", err.message));
    };

    store.mongo = {
      connected: true,
      dbName,
      client,
      db
    };

    return store.mongo;
  } catch (error) {
    console.error(`[MongoDB Atlas] No se pudo conectar a MongoDB (${error.message}). Continuando con almacenamiento local.`);
    return null;
  }
}
