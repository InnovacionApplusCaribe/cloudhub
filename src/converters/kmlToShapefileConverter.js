/**
 * @fileoverview Utility module responsible for transforming raw KML geometry representations
 * into a standardized Feature array structure expected by the ShapefileLoader and 3D Viewer.
 * This acts as the bridge between the KML-specific parsing and the common GIS format.
 */

/**
 * Helper to generate a unique ID for a feature if one is not provided.
 * @returns {string} A unique identifier.
 */
function generateUniqueId() {
    // In a real application, this would use a proper UUID library.
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

/**
 * Recursively maps various KML geometry types (Point, LineString, Polygon)
 * to a standardized coordinate format: an array of [lon, lat, alt].
 * @param {object} geometry - The raw geometry object parsed from KML.
 * @returns {Array<Array<number>>} The standardized coordinates array.
 */
function mapGeometry(geometry) {
    // *** Implementation details must map KML structure to Lon/Lat/Alt ***
    if (!geometry || typeof geometry.coordinates === 'undefined') {
        return [];
    }

    // Example: Simple check for coordinates array if it's already flat
    if (Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0) {
        // Assuming KML coordinates are [longitude, latitude, altitude]
        return geometry.coordinates.map(coord => {
            if (Array.isArray(coord) && coord.length >= 2) {
                return [
                    coord[0] || 0, // Longitude
                    coord[1] || 0, // Latitude
                    coord[2] || null // Altitude (optional)
                ];
            }
            return [coord[0] || 0, coord[1] || 0, null];
        });
    }
    // Add complex logic for multi-dimensional geometries if necessary
    return [];
}


/**
 * Converts a raw KML feature into a standardized Feature object.
 * @param {object} kmlFeature - The feature object parsed from KML.
 * @returns {object} A standardized feature object compatible with ShapefileLoader's expected input.
 */
function convertKmlFeatureToFeature(kmlFeature) {
    const geometry = kmlFeature.geometry;
    if (!geometry) {
        return null;
    }

    const standardizedCoordinates = mapGeometry(geometry);

    // In a real system, this would differentiate between Point, Line, Polygon features
    // For simplicity here, we assume the primary geometry is what needs to be stored.
    const feature = {
        id: kmlFeature.id || generateUniqueId(),
        geometry: {
            type: geometry.type || "GeometryCollection", // Placeholder for GeoJSON type
            coordinates: standardizedCoordinates,
        },
        properties: {
            name: kmlFeature.name || '',
            description: kmlFeature.description || ''
        }
    };
    return feature;
}

/**
 * Orchestrates the conversion of an array of raw KML features into a Shapefile-compatible Feature array.
 * @param {Array<object>} kmlFeatures - Array of raw feature objects parsed by KmlLoader.
 * @returns {Array<object>} An array of standardized feature objects ready for loading.
 */
export function convertKmlToShapefile(kmlFeatures) {
    if (!Array.isArray(kmlFeatures)) {
        console.error("Input to convertKmlToShapefile must be an array of features.");
        return [];
    }

    console.log(`Starting conversion of ${kmlFeatures.length} KML features...`);

    const shapefileFeatures = kmlFeatures
        .map(convertKmlFeatureToFeature)
        .filter(Boolean); // Remove any features that failed conversion

    console.log(`Conversion complete. Successfully converted ${shapefileFeatures.length} features.`);
    return shapefileFeatures;
}