import {Utils} from "../../utils.js";

export class GisPanel {
	constructor(viewer, layer, propertiesPanel) {
		this.viewer = viewer;
		// 'layer' could be a GisLayer or a GisFeature from the side panel click
		this.layer = layer;
		this.propertiesPanel = propertiesPanel;
		this.container = propertiesPanel.container;
		
		const gisLayer = (this.layer && this.layer.type === "GisFeature") ? this.layer.layer : this.layer;
		if (gisLayer) {
			this.propertiesPanel.addVolatileListener(gisLayer, "gis_feature_selected", () => {
				this.update();
			});
		}

		this.update();
	}

	update() {
		this.container.empty();

		const isFeature = this.layer && this.layer.type === "GisFeature";
		const feature = isFeature ? this.layer : null;
		
		// Fallback to selectedFeature via picking if not directly selected in tree
		const activeFeature = feature || (this.layer.type === "GisLayer" ? this.layer.selectedFeature : null);
		
		const gisLayer = isFeature ? this.layer.layer : this.layer;
		const layerName = gisLayer.name || "GIS Layer";
		
		let elHeader = $(`
			<div class="pv-menu-list">
				<div class="divider"><span>GIS Layer: ${layerName}</span></div>
			</div>
		`);
		this.container.append(elHeader);

		// Global options for the Layer
		let elSettings = $(`<div class="pv-menu-list" style="margin-bottom: 20px;"></div>`);

		// 1) Point Size Slider
		if (gisLayer.pointsMesh) {
			let savedSize = localStorage.getItem(`Potree_GisLayer_${layerName}_pointSize`);
			if(savedSize !== null) {
				gisLayer.pointsMesh.material.size = parseFloat(savedSize);
			}

			elSettings.append(`
				<li style="margin: 10px 0;">
					<span>Point Size</span>: <span id="lblGisPointSize">${gisLayer.pointsMesh.material.size.toFixed(1)}</span>
					<div id="sldGisPointSize" style="margin-top: 5px;"></div>
				</li>
			`);
		}

		// 2) Polygon Color
		if (gisLayer.polygonMesh) {
			let savedColor = localStorage.getItem(`Potree_GisLayer_${layerName}_polygonColor`);
			if(savedColor !== null) {
				gisLayer.polygonMesh.material.color.setHex(parseInt(savedColor, 10));
			}

			elSettings.append(`
				<div style="margin: 10px 0;">
					<span style="display:block; margin-bottom:5px;">Polygon Fill Color</span>
					<input id="gis_polygon_color" />
				</div>
			`);
		}

		if (gisLayer.pointsMesh || gisLayer.polygonMesh) {
			this.container.append(elSettings);
		}

		// Activate Slider
		if (gisLayer.pointsMesh) {
			let sld = elSettings.find("#sldGisPointSize");
			sld.slider({
				value: gisLayer.pointsMesh.material.size,
				min: 1, max: 20, step: 0.1,
				slide: (event, ui) => {
					gisLayer.pointsMesh.material.size = ui.value;
					elSettings.find("#lblGisPointSize").html(ui.value.toFixed(1));
					localStorage.setItem(`Potree_GisLayer_${layerName}_pointSize`, ui.value);
				}
			});
		}

		// Activate Color Picker
		if (gisLayer.polygonMesh) {
			elSettings.find("#gis_polygon_color").spectrum({
				flat: false,
				showInput: true,
				preferredFormat: 'rgb',
				cancelText: '',
				chooseText: 'Apply',
				color: `#${gisLayer.polygonMesh.material.color.getHexString()}`,
				move: color => {
					let cRGB = color.toRgb();
					gisLayer.polygonMesh.material.color.setRGB(cRGB.r / 255, cRGB.g / 255, cRGB.b / 255);
					localStorage.setItem(`Potree_GisLayer_${layerName}_polygonColor`, gisLayer.polygonMesh.material.color.getHex());
				},
				change: color => {
					let cRGB = color.toRgb();
					gisLayer.polygonMesh.material.color.setRGB(cRGB.r / 255, cRGB.g / 255, cRGB.b / 255);
					localStorage.setItem(`Potree_GisLayer_${layerName}_polygonColor`, gisLayer.polygonMesh.material.color.getHex());
				}
			});
		}

		// Feature Attributes
		if (activeFeature) {
			let elFeatureInfo = $(`
				<div class="pv-menu-list">
					<div class="divider"><span>Feature: ${activeFeature.name}</span></div>
					<table class="measurement_value_table" style="width: 100%; border-collapse: collapse;">
						<thead>
							<tr style="background: rgba(255,255,255,0.1)">
								<th style="padding: 4px; text-align: left;">Field</th>
								<th style="padding: 4px; text-align: left;">Value</th>
							</tr>
						</thead>
						<tbody id="gis_attribute_body"></tbody>
					</table>
				</div>
			`);
			
			const tbody = elFeatureInfo.find("#gis_attribute_body");
			const props = activeFeature.feature.properties || {};
			
			for (const key of Object.keys(props)) {
				const val = props[key];
				const row = $(`
					<tr style="border-bottom: 1px solid rgba(255,255,255,0.05)">
						<td style="padding: 4px; font-weight: bold; font-size: 0.9em;">${key}</td>
						<td style="padding: 4px; font-size: 0.9em; word-break: break-all;">${val}</td>
					</tr>
				`);
				tbody.append(row);
			}
			
			this.container.append(elFeatureInfo);

		} else {
			let elNoSelection = $(`
				<div style="padding: 20px; text-align: center; opacity: 0.5;">
					Select a specific feature to view its attributes.
				</div>
			`);
			this.container.append(elNoSelection);
		}
	}
}
