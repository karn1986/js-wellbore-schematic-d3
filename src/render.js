/*
 * Copyright © 2020. TIBCO Software Inc.
 * This file is subject to the license terms contained
 * in the license file that is distributed with this file.
 */

//@ts-check
import * as d3 from "d3";
import { invalidateTooltip } from "./extended-api.js";
import { nodeFormattedPathAsArray } from "./extended-api.js";
import { addHandlersSelection } from "./ui-input.js";

/**
 * @typedef {{
 *          colorIndex: number;
 *          markedColor: string;
 *          unmarkedColor: string;
 *          markedSegments: number[][]
 *          name: string;
 *          }} RenderGroup;
 */

/**
 * Prepare some dom elements that will persist  throughout mod lifecycle
 */
const modContainer = d3.select("#mod-container");

/**
 * Main svg container
 */
const svg = modContainer.append("svg").attr("xmlns", "http://www.w3.org/2000/svg");

/**
 * Renders the chart.
 * @param {Object} state
 * @param {Spotfire.Mod} mod
 * @param {Spotfire.DataView} dataView - dataView
 * @param {Spotfire.Size} windowSize - windowSize
 */
export async function render(state, mod, dataView, windowSize) {
    if (state.preventRender) {
        // Early return if the state currently disallows rendering.
        return;
    }

    // The margins around the chart canvas.
    const margin = { top: 20, right: 40, bottom: 40, left: 80 };
    // wellbore radius in pixels
    const r = 0.025 * Math.min(windowSize.height, windowSize.width);
    // The position and size of the chart canvas.
    const canvas = { 
        top: margin.top,
        left: margin.left,
        width: windowSize.width - (margin.left + margin.right),
        height: windowSize.height - (margin.top + margin.bottom)

    };
    /**
     * Sets the viewBox to match windowSize
     */
    svg.attr("viewBox", [0, 0, windowSize.width, windowSize.height]);
    svg.selectAll("*").remove();

    if (canvas.height < 0 || canvas.width < 0) {
        // Abort rendering if the window is not large enough to render anything.
        return;
    }

    const onSelection = ({ dragSelectActive }) => {
        state.preventRender = dragSelectActive;
    };

    const context = mod.getRenderContext();
    const styling = context.styling;
    const { tooltip, popout } = mod.controls;
    const { radioButton, checkbox } = popout.components;
    const { section } = popout;

    invalidateTooltip(tooltip);

    /**
     * The DataView can contain errors which will cause rowCount method to throw.
     */
    let errors = await dataView.getErrors();
    if (errors.length > 0) {
        mod.controls.errorOverlay.show(errors, "dataView");
        return;
    }

    mod.controls.errorOverlay.hide("dataView");

    const allrows = await dataView.allRows();
    const survey = get_survey(allrows, mod);
    const processed_survey = min_curvature_algo(survey);
    const {xScale, yScale} = get_scales(processed_survey, margin, windowSize);
    compute_slope(processed_survey, xScale, yScale);

    let curve = d3.curveCatmullRom.alpha(1);
    /**
     * Prepare groups that will hold all elements of chart.
     */
    svg.append("g").attr("class", "wellbore");
    svg.append("g").attr("class", "axes");
    /**
     * Style all strokes and text using current theme.
     */
    svg.selectAll("path").attr("stroke", styling.scales.line.stroke);
    svg.selectAll("line").attr("stroke", styling.scales.tick.stroke);
    svg.selectAll("text")
        .attr("fill", styling.scales.font.color)
        .attr("font-family", styling.scales.font.fontFamily)
        .attr("font-size", styling.scales.font.fontSize);

    draw_axes(svg.select(".axes"), xScale, yScale, windowSize, margin);
    draw_wellbore(svg.select(".wellbore"), processed_survey, xScale, yScale, curve, r, tooltip)
}
// --------------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------------
// function to preprocess and validate survey data
function get_survey(allrows, mod) {
    let survey;
    try{
        survey = allrows.map((d, i) => {
            const md = d.continuous("md").value();
            const inc  = d.continuous("inc").value();
            const az = d.continuous("az").value();
            if ((inc < 0) || (inc > 180)) {
                throw new Error(`Inclination ${inc} out of range at row ${i+1}. check survey`);
            } else if(md<0) {
                throw new Error(`MD ${md} cannot be negative. check survey at row ${i+1}`);
            } else if (az < 0 || az > 360){
                throw new Error(`Azimuth ${az} out of range at row ${i+1}. check survey`);
            }
            return {md: md, inc: inc, az: az}
        }).sort((a, b) => a.md - b.md);
    } catch (err) {
        mod.controls.errorOverlay.show(err.message, "survey");
        return;
    }
    mod.controls.errorOverlay.hide("survey");
    if (survey[0].md > 0.1) {
        survey.unshift({md:0, inc:0, az:0});
    }
    return survey;
}
// Function to process the survey using minimum curvature algorithm
function min_curvature_algo(survey) {
    let processed_survey = [];
    processed_survey.push({...survey[0], ...{ew:0, ns:0, tvd:0, x:0}});
    for (var i = 1; i < survey.length ; i++) {
        const I1 = survey[i-1].inc * Math.PI / 180;
        const I2 = survey[i].inc * Math.PI / 180;
        const A1 = survey[i-1].az * Math.PI / 180;
        const A2 = survey[i].az * Math.PI / 180;
        const beta = Math.acos(Math.sin(I1) * Math.sin(I2) *(Math.cos(A2 - A1)-1)+Math.cos(I2-I1));
        let rf = 1;
        if (Math.abs(beta) > 0.00001) {
            rf = 2 * Math.tan(beta/2) / beta;
        }
        const dmd = survey[i].md - survey[i-1].md;
        const dz = 0.5* dmd * rf * (Math.cos(I1) + Math.cos(I2));
        const dx = 0.5* dmd * rf * (Math.sin(I1)* Math.sin(A1)+Math.sin(I2)* Math.sin(A2));
        const dy = 0.5* dmd * rf * (Math.sin(I1)* Math.cos(A1)+Math.sin(I2)* Math.cos(A2));
        const ds = Math.sqrt(dx*dx+dy*dy);
        let {ew, ns, tvd, x} = processed_survey[i-1];
        processed_survey.push({...survey[i], ...{ew:ew+dx, ns:ns+dy, tvd:tvd+dz, x:x+ds}});
    };
    return processed_survey;
}
// determine scales
function get_scales(survey, margin, windowSize) {
    const ydomain = d3.extent(survey, p => p.tvd)
    // Define the Y scale
    let yScale = d3.scaleLinear()
            .domain([ydomain[0] - 0.01*ydomain[1], 1.05 *ydomain[1]]).nice(20)
            .range([ margin.top, windowSize.height - margin.bottom]);
    

    const xdomain = d3.extent(survey, p => p.x);
    //  Define the X scale
    let xScale = d3.scaleLinear()
            .domain([xdomain[0] - 0.01*xdomain[1], 1.05* xdomain[1]]).nice(20)
            .range([margin.left, windowSize.width - margin.right]);

    return {xScale: xScale, yScale: yScale}
}
// function to compute the slope along the survey
function compute_slope(survey, xScale, yScale) {
    const i1 = survey.length - 1;
    for (var i = 0; i < survey.length ; i++) {
        let m, theta;
        if (i==0) {
            m = (yScale(survey[i].tvd)-yScale(survey[i+1].tvd))/(xScale(survey[i+1].x)-xScale(survey[i].x));
        } else if (i == i1) {
            m = (yScale(survey[i-1].tvd)-yScale(survey[i].tvd))/(xScale(survey[i].x)-xScale(survey[i-1].x));
        } else {
            m =  0.5 * (yScale(survey[i].tvd)-yScale(survey[i+1].tvd))/(xScale(survey[i+1].x)-xScale(survey[i].x));
            m += 0.5 * (yScale(survey[i-1].tvd)-yScale(survey[i].tvd))/(xScale(survey[i].x)-xScale(survey[i-1].x));
        }
        theta = Math.atan(-1/m);
        // console.log(`at md ${survey[i].md}, x= ${survey[i].x}, tvd = ${survey[i].tvd}, m = ${m} and theta = ${theta}`)
        theta = (theta >= 0) ? theta: Math.PI + theta;
        survey[i]["theta"] = isNaN(theta) ? survey[i-1].theta : theta; 
    }
}
// draw axes
function draw_axes(container, xScale, yScale, windowSize, margin) {
    container
        .append("g")
        .attr("transform", `translate(0,${windowSize.height - margin.bottom})`)
        .call(d3.axisBottom(xScale)
            // .tickSize(styling.scales.tick.stroke != "none" ? 5 : 0)
            // .tickPadding(styling.scales.tick.stroke != "none" ? 3 : 9)
            )
        .call(g => g.append("text")
            .attr("x", d3.mean(xScale.range()))
            .attr("y", 40)
            .attr("fill", "currentColor")
            .attr("text-anchor", "start")
            .text('Distance (ft)'));

    container
        .append("g")
        .attr("transform", `translate(${margin.left},0)`)
        .call(
            d3.axisLeft(yScale)
            // .tickSize(styling.scales.tick.stroke != "none" ? 5 : 0)
            // .tickPadding(styling.scales.tick.stroke != "none" ? 3 : 9)
        )
        .call(g => g.append("text")
            .attr("transform", "rotate(-90)")
            .attr("dy", -50)
            .attr("dx", -0.5 * d3.mean(xScale.range()))
            .attr("fill", "currentColor")
            .attr("text-anchor", "start")
            .text('TVD (ft)')); 
}
// 
function draw_wellbore(container, survey, xScale, yScale, curve, r, tooltip) {
    // center line of the wellbore 
    let line1 = d3
        .line()
        .x(d => xScale(d.x))
        .y(d => yScale(d.tvd))
        .curve(curve);
    // top of casing
    let line2 = d3
        .line()
        .x(d => xScale(d.x) + r * Math.cos(d.theta))
        .y(d => yScale(d.tvd) - r * Math.sin(d.theta))
        .curve(curve);
    // bottom of casing
    let line3 = d3
        .line()
        .x((d) => xScale(d.x) - r * Math.cos(d.theta))
        .y((d) => yScale(d.tvd) + r * Math.sin(d.theta))
        .curve(curve);

    container
        .append("path")
        .datum(survey)
        .attr("stroke", "black")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray",4)
        .attr("fill", "none")
        .attr("d", line1)

    container
        .append("path")
        .datum(survey)
        .attr("stroke", "red")
        .attr("stroke-width", 2)
        .attr("fill", "none")
        .attr("d", line2);

    container
        .append("path")
        .datum(survey)
        .attr("stroke", "red")
        .attr("stroke-width", 2)
        .attr("fill", "none")
        .attr("d", line3);

    container
        .selectAll("circle")
        .data(survey)
        .enter()
        .append("circle")
        .attr("stroke", "none")
        .attr("fill", "none")
        .attr("pointer-events", "all")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.tvd))
        .attr("r", 5)
        .on("mouseover", pointermoved)
        .on("mouseout", () => tooltip.hide());

    function pointermoved(event, d) {
    // const i = d3.bisectCenter(survey.map(d => d.x), xScale.invert(d3.pointer(event)[0]));

    tooltip.show(` MD: ${d.md.toLocaleString('en-US', { maximumFractionDigits: 0 })} | TVD: ${d.tvd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    // setTimeout(() =>  tooltip.hide(), 5000);
    }
}